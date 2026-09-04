import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { RunRecord, WorkflowRunRecord } from "../src/domain/types.js";
import { GlobalWorkerRegistry, GlobalWorkflowRegistry } from "../src/state/global-worker-registry.js";

function workflowRun(options: { root?: string; status?: WorkflowRunRecord["status"]; updatedAt?: string } = {}): WorkflowRunRecord {
  const repository = { id: "acme-api", root: options.root ?? "/projects/acme-api" };
  return {
    id: `workflow:${repository.root}:implement:linear-1:one`,
    identity: { repository, workflowId: "implement", sourceId: "linear", itemId: "linear-1", occurrence: "one" },
    item: { sourceId: "linear", id: "linear-1", title: "Index workflow runs" },
    status: options.status ?? "running",
    jobs: {
      implement: {
        status: "started", runId: "run-1", workerId: "wrk-1", attempts: 1,
        startedAt: "2026-08-27T09:00:00.000Z", outputs: { branch: "relay/index" },
      },
      review: { status: "pending", attempts: 0 },
    },
    startedAt: "2026-08-27T09:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-08-27T09:01:00.000Z",
    concurrencyGroup: "linear-1",
  };
}

describe("GlobalWorkflowRegistry", () => {
  it("registers distinct checkout folders for one repository and indexes jobs/events", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-workflows-"));
    try {
      const registry = new GlobalWorkflowRegistry({ stateHome });
      const first = registry.registerProjectFolder({ id: "acme-api", root: "/projects/acme-api" }, { displayName: "Main", configHash: "a", configStatus: "valid" });
      const second = registry.registerProjectFolder({ id: "acme-api", root: "/tmp/acme-api" }, { enabled: false });
      expect(first.id).not.toBe(second.id);
      expect(registry.listProjectFolders()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.id, displayName: "Main", enabled: true, configStatus: "valid" }),
        expect.objectContaining({ id: second.id, enabled: false }),
      ]));

      const run = workflowRun();
      const stored = registry.syncRun(run);
      expect(stored).toMatchObject({ projectFolderId: first.id, identity: { workflowId: "implement" }, status: "running" });
      expect(registry.listJobs(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ jobId: "implement", status: "started", workerId: "wrk-1", outputs: { branch: "relay/index" } }),
        expect.objectContaining({ jobId: "review", status: "pending", attempts: 0 }),
      ]));
      const event = registry.appendEvent(run.id, "job_started", run.updatedAt, { via: "sync" }, "implement");
      expect(registry.listEvents(run.id)).toEqual([expect.objectContaining({ id: event.id, jobId: "implement", data: { via: "sync" } })]);
      expect(registry.list({ projectFolderId: first.id, statuses: ["running"] })).toHaveLength(1);
      registry.close();
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("imports idempotently and never regresses an execution from an older state snapshot", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-workflows-"));
    try {
      const registry = new GlobalWorkflowRegistry({ stateHome });
      const current = workflowRun({ status: "succeeded", updatedAt: "2026-08-27T10:00:00.000Z" });
      current.completedAt = current.updatedAt;
      current.jobs.implement = { ...current.jobs.implement!, status: "succeeded", completedAt: current.updatedAt };
      registry.importRuns([current, current]);
      const stale = workflowRun({ status: "running", updatedAt: "2026-08-27T09:01:00.000Z" });
      expect(registry.syncRun(stale)).toMatchObject({ status: "succeeded", completedAt: current.updatedAt });
      expect(registry.listJobs(current.id)).toEqual([expect.objectContaining({ jobId: "implement", status: "succeeded" }), expect.objectContaining({ jobId: "review" })]);
      registry.close();
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("uses a canonical folder override and soft-removes folders without deleting run history", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-workflows-"));
    try {
      const registry = new GlobalWorkflowRegistry({ stateHome });
      const canonical = { id: "github.com/acme/api", root: "/projects/acme-api" };
      const legacy = workflowRun({ root: "/legacy/project-name" });
      const stored = registry.syncRun(legacy, { repository: canonical, at: "2026-08-27T09:02:00.000Z" });
      const folder = registry.getProjectFolder(stored.projectFolderId)!;
      expect(folder).toMatchObject({ repository: canonical, lastSyncedAt: "2026-08-27T09:02:00.000Z" });
      expect(stored.snapshot.identity.repository).toEqual(canonical);

      expect(registry.updateProjectFolder(folder.id, {
        displayName: "API checkout", enabled: false, configHash: "new-hash", configStatus: "invalid",
        lastSyncedAt: "2026-08-27T09:03:00.000Z",
      })).toMatchObject({ displayName: "API checkout", enabled: false, configStatus: "invalid" });
      expect(registry.removeProjectFolder(folder.id, "2026-08-27T09:04:00.000Z")).toMatchObject({ removedAt: "2026-08-27T09:04:00.000Z" });
      expect(registry.listProjectFolders()).toEqual([]);
      expect(registry.listProjectFolders({ includeRemoved: true })).toEqual([expect.objectContaining({ id: folder.id })]);
      expect(registry.get(legacy.id)).toMatchObject({ id: legacy.id, projectFolderId: folder.id });
      // A later state-file import must not silently re-register a folder the
      // user removed from the global dashboard.
      registry.syncRun(legacy, { repository: canonical, at: "2026-08-27T09:05:00.000Z" });
      expect(registry.listProjectFolders()).toEqual([]);
      expect(registry.list({ includeRemoved: true })).toHaveLength(1);
      registry.close();
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("repairs a canonical checkout binding without letting an equal snapshot regress job state", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-workflows-"));
    try {
      const registry = new GlobalWorkflowRegistry({ stateHome });
      const finished = workflowRun({ status: "succeeded", updatedAt: "2026-08-27T10:00:00.000Z" });
      finished.jobs.implement = { ...finished.jobs.implement!, status: "succeeded", completedAt: finished.updatedAt };
      registry.syncRun(finished);
      const canonical = { id: "github.com/acme/api", root: "/canonical/acme-api" };
      const stale = workflowRun({ updatedAt: finished.updatedAt });
      const rebound = registry.syncRun(stale, { repository: canonical });
      expect(rebound.snapshot.identity.repository).toEqual(canonical);
      expect(rebound.status).toBe("succeeded");
      expect(registry.listJobs(rebound.id)).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: "implement", status: "succeeded" })]));
      registry.close();
    } finally { await rm(stateHome, { recursive: true, force: true }); }
  });

  it("migrates a version-2 worker registry in place without losing worker rows", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-workflow-migration-"));
    try {
      const workers = new GlobalWorkerRegistry({ stateHome });
      const worker: RunRecord = {
        id: "run-1",
        identity: { repository: { id: "acme-api", root: "/projects/acme-api" }, sourceId: "linear", itemId: "linear-1", triggerId: "implement" },
        item: { sourceId: "linear", id: "linear-1", title: "Keep worker data" },
        trigger: { id: "implement", sourceId: "linear", repository: { id: "acme-api", root: "/projects/acme-api" }, enabled: true },
        agent: { agentId: "codex" }, status: "running",
        claimedAt: "2026-08-27T09:00:00.000Z", updatedAt: "2026-08-27T09:01:00.000Z",
      };
      const storedWorker = workers.upsertRun(worker);
      const file = workers.file;
      workers.close();
      const legacy = new DatabaseSync(file);
      legacy.exec("DROP TABLE workflow_events; DROP TABLE workflow_job_runs; DROP TABLE workflow_runs; DROP TABLE project_folders; PRAGMA user_version = 2");
      legacy.close();

      const workflows = new GlobalWorkflowRegistry({ stateHome });
      expect(workflows.registerProjectFolder({ id: "acme-api", root: "/projects/acme-api" })).toMatchObject({ repository: { id: "acme-api" } });
      workflows.close();
      const reopenedWorkers = new GlobalWorkerRegistry({ stateHome });
      expect(reopenedWorkers.get(storedWorker.id)).toMatchObject({ id: storedWorker.id, runId: "run-1", status: "running" });
      reopenedWorkers.close();
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });
});
