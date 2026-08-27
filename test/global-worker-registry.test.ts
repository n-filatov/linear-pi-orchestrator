import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/domain/types.js";
import {
  AmbiguousIssueKeyError,
  GlobalWorkerRegistry,
  globalWorkerRegistryPath,
  workerGenerationId,
} from "../src/state/global-worker-registry.js";

function run(options: { repositoryId?: string; root?: string; itemId?: string; issueKey?: string; claimedAt?: string } = {}): RunRecord {
  const repository = { id: options.repositoryId ?? "acme-api", root: options.root ?? "/projects/acme-api" };
  const itemId = options.itemId ?? "linear-immutable-1";
  const claimedAt = options.claimedAt ?? "2026-08-27T09:00:00.000Z";
  return {
    id: `run:${repository.id}:${itemId}:${claimedAt}`,
    identity: { repository, sourceId: "linear", itemId, triggerId: "implement" },
    item: { sourceId: "linear", id: itemId, title: "Persist workers", metadata: { identifier: options.issueKey ?? "CRM-539" } },
    trigger: { id: "implement", sourceId: "linear", repository, enabled: true },
    agent: { agentId: "codex", model: "gpt-5" },
    status: "running",
    claimedAt,
    updatedAt: "2026-08-27T09:01:00.000Z",
    workspace: { path: `/work/${itemId}`, branch: "relay/CRM-539" },
    worker: { id: `tmux-worker-${itemId}-${claimedAt}`, startedAt: claimedAt, metadata: { tmux: { session: "relay", window: "CRM-539", pane: "%42" }, panePid: 991, processGroupId: 990 } },
  };
}

describe("GlobalWorkerRegistry", () => {
  it("persists a generation across registry instances and rebases a moved checkout", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-registry-"));
    try {
      const original = run();
      const registry = new GlobalWorkerRegistry({ stateHome });
      const stored = registry.upsertRun(original);
      expect(stored.id).toBe(workerGenerationId(original));
      expect(registry.file).toBe(globalWorkerRegistryPath(stateHome));
      expect(stored).toMatchObject({ sourceId: "linear", itemId: "linear-immutable-1", issueKey: "CRM-539", workspacePath: "/work/linear-immutable-1", branch: "relay/CRM-539", harness: "codex" });
      expect(stored.runtime).toMatchObject({ tmuxSession: "relay", tmuxWindow: "CRM-539", tmuxPane: "%42", panePid: 991, processGroupId: 990 });
      registry.close();

      const moved = run({ root: "/another/clone/acme-api" });
      const restarted = new GlobalWorkerRegistry({ stateHome });
      const afterMove = restarted.upsertRun(moved);
      expect(afterMove.id).toBe(stored.id);
      expect(afterMove.repository.root).toBe("/another/clone/acme-api");
      expect(restarted.findByRunId(moved.id)?.id).toBe(stored.id);
      restarted.close();
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("indexes Linear by immutable provider id while retaining the human issue key", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-registry-"));
    try {
      const registry = new GlobalWorkerRegistry({ stateHome });
      const linear = run({ itemId: "CRM-539" });
      linear.item.metadata = { linearIssueId: "b2b1ad82-immutable", linearIdentifier: "CRM-539" };
      const stored = registry.upsertRun(linear);
      expect(stored).toMatchObject({ itemId: "b2b1ad82-immutable", issueKey: "CRM-539" });
      expect(registry.lookupByIssueKey({ issueKey: "crm-539" })).toMatchObject({ kind: "found", worker: { id: stored.id } });
      registry.close();
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("derives the same generation id from a canonical repository across clones", () => {
    const left = run({ repositoryId: "local-name-a", root: "/clone/a" });
    const right = run({ repositoryId: "local-name-b", root: "/clone/b" });
    expect(workerGenerationId(left, "github.com/acme/crm")).toBe(workerGenerationId(right, "github.com/acme/crm"));
  });

  it("migrates a v1 registry by assigning each worker its owning checkout root", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-registry-migration-"));
    try {
      const first = new GlobalWorkerRegistry({ stateHome });
      const stored = first.upsertRun(run({ root: "/projects/original-crm" }));
      const file = first.file;
      first.close();

      const legacy = new DatabaseSync(file);
      legacy.exec("ALTER TABLE workers DROP COLUMN repository_root");
      legacy.exec("PRAGMA user_version = 1");
      legacy.close();

      const migrated = new GlobalWorkerRegistry({ stateHome });
      expect(migrated.get(stored.id)?.repository.root).toBe("/projects/original-crm");
      migrated.close();
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("does not silently choose an issue key shared by repositories or sources", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-registry-"));
    try {
      const registry = new GlobalWorkerRegistry({ stateHome });
      const first = registry.upsertRun(run());
      registry.upsertRun(run({ claimedAt: "2026-08-27T09:02:00.000Z" }));
      registry.upsertRun(run({ repositoryId: "billing", root: "/projects/billing", itemId: "linear-immutable-2" }));

      const ambiguous = registry.lookupByIssueKey({ issueKey: "CRM-539" });
      expect(ambiguous.kind).toBe("ambiguous");
      expect(ambiguous.workers).toHaveLength(3);
      expect(() => registry.findByIssueKey({ issueKey: "CRM-539" })).toThrow(AmbiguousIssueKeyError);

      const selected = registry.lookupByIssueKey({ issueKey: "CRM-539", repositoryId: "acme-api", sourceId: "linear" });
      expect(selected).toMatchObject({ kind: "found", worker: { generation: "2026-08-27T09:02:00.000Z" } });
      registry.close();
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("updates runtime and cleanup state, retains events, and imports idempotently", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-registry-"));
    try {
      const registry = new GlobalWorkerRegistry({ stateHome });
      const first = run();
      const stored = registry.upsertRun(first);
      registry.updateRuntimeHandle(stored.id, { tmuxSession: "new-server", tmuxWindow: "@99", tmuxPane: "%101", panePid: 1234, processGroupId: 1200 }, "2026-08-27T10:00:00.000Z");
      registry.updateStatus(stored.id, "cleanup_failed", { at: "2026-08-27T10:01:00.000Z", cleanupError: "process group still alive" });
      const event = registry.appendEvent(stored.id, "cleanup_failed", "2026-08-27T10:01:00.000Z", { pid: 1234 });

      expect(registry.get(stored.id)).toMatchObject({ status: "cleanup_failed", cleanupError: "process group still alive", runtime: { tmuxWindow: "@99", processGroupId: 1200 } });
      expect(registry.listEvents(stored.id)).toEqual([expect.objectContaining({ id: event.id, type: "cleanup_failed", data: { pid: 1234 } })]);

      registry.importRuns([first]);
      expect(registry.list({ repositoryId: "acme-api", includeCleaned: true })).toEqual([expect.objectContaining({ id: stored.id, status: "cleanup_failed" })]);
      registry.close();
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });
});
