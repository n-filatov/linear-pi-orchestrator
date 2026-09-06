import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalWorkflowRegistry } from "../src/state/global-worker-registry.js";
import { IndexedWorkflowRunStore } from "../src/state/indexed-workflow-run-store.js";
import { RepositoryStateStore } from "../src/state/store.js";

const originalStateHome = process.env.XDG_STATE_HOME;
afterEach(() => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
});

describe("IndexedWorkflowRunStore", () => {
  it("mirrors transitions into the canonical global folder and event log", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-indexed-workflow-"));
    const stateHome = await mkdtemp(join(tmpdir(), "relay-indexed-global-"));
    process.env.XDG_STATE_HOME = stateHome;
    const registry = new GlobalWorkflowRegistry({ stateHome });
    const repositoryStore = new RepositoryStateStore(root);
    const canonical = { id: "github.com/example/project", root };
    const indexed = new IndexedWorkflowRunStore(repositoryStore, registry, canonical);
    const identity = { repository: { id: "legacy-name", root }, workflowId: "ship", sourceId: "queue", itemId: "T-1", occurrence: "one" };

    const opened = await indexed.openWorkflowRun({
      identity,
      item: { sourceId: "queue", id: "T-1", title: "Ship it", state: "open", metadata: {} },
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    await indexed.updateWorkflowJob(identity, "build", { status: "succeeded", at: "2026-01-01T00:01:00.000Z", attempted: true });
    await indexed.finishWorkflowRun(identity, "succeeded", "2026-01-01T00:02:00.000Z");

    const global = registry.get(opened.id)!;
    expect(registry.getProjectFolder(global.projectFolderId)?.repository).toEqual(canonical);
    expect(global.status).toBe("succeeded");
    expect(registry.listJobs(opened.id)).toEqual([expect.objectContaining({ jobId: "build", status: "succeeded" })]);
    expect(registry.listEvents(opened.id).map((event) => event.type)).toEqual(["workflow.opened", "workflow.job.updated", "workflow.finished"]);
    registry.close();
  });

  it("keeps the repository transition successful when the rebuildable index is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-indexed-workflow-fallback-"));
    process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "relay-indexed-workflow-fallback-state-"));
    const repositoryStore = new RepositoryStateStore(root);
    const errors: unknown[] = [];
    const unavailable = {
      syncRun: () => { throw new Error("sqlite unavailable"); },
      appendEvent: () => { throw new Error("sqlite unavailable"); },
      importRuns: () => { throw new Error("sqlite unavailable"); },
    } as unknown as GlobalWorkflowRegistry;
    const indexed = new IndexedWorkflowRunStore(repositoryStore, unavailable, { id: "repo", root }, (error) => errors.push(error));
    const identity = { repository: { id: "repo", root }, workflowId: "ship", sourceId: "queue", itemId: "T-2", occurrence: "one" };
    await expect(indexed.openWorkflowRun({ identity, item: { sourceId: "queue", id: "T-2", title: "Ship" }, startedAt: "2026-01-01T00:00:00.000Z" })).resolves.toMatchObject({ identity });
    expect((await repositoryStore.findWorkflowRun(identity))?.id).toBeTruthy();
    expect(errors).toHaveLength(1);
  });

  it("replays a raw-ledger workflow projection exactly once after index recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-indexed-outbox-"));
    const stateHome = await mkdtemp(join(tmpdir(), "relay-indexed-outbox-state-"));
    process.env.XDG_STATE_HOME = stateHome;
    const store = new RepositoryStateStore(root);
    const repository = { id: "repo", root };
    const identity = { repository, workflowId: "ship", sourceId: "queue", itemId: "T-3", occurrence: "one" };

    // This intentionally bypasses IndexedWorkflowRunStore: state and its
    // outbox must commit together before a projector is available.
    const opened = await store.openWorkflowRun({ identity, item: { sourceId: "queue", id: "T-3", title: "Ship" }, startedAt: "2026-01-01T00:00:00.000Z" });
    expect(await store.pendingProjections()).toHaveLength(1);

    const unavailable = {
      syncRun: () => { throw new Error("index unavailable"); },
      appendProjectedEvent: () => { throw new Error("index unavailable"); },
      appendEvent: () => { throw new Error("index unavailable"); },
      importRuns: () => { throw new Error("index unavailable"); },
    } as unknown as GlobalWorkflowRegistry;
    const errors: unknown[] = [];
    await new IndexedWorkflowRunStore(store, unavailable, repository, (error) => errors.push(error)).listWorkflowRuns(repository);
    expect(await store.pendingProjections()).toHaveLength(1);
    expect(errors).toHaveLength(1);

    const registry = new GlobalWorkflowRegistry({ stateHome });
    const recovered = new IndexedWorkflowRunStore(store, registry, repository);
    await recovered.listWorkflowRuns(repository);
    await recovered.listWorkflowRuns(repository);
    expect(await store.pendingProjections()).toHaveLength(0);
    expect(registry.listEvents(opened.id).map((event) => event.type)).toEqual(["workflow.opened"]);
    registry.close();
  });
});
