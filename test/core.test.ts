import { describe, expect, it, vi } from "vitest";
import { TaskRelay } from "../src/core/task-relay.js";
import { createRunKey, isActiveRun, type AgentLauncher, type AgentResolution, type RelayLogger, type RepositoryScope, type RunClaim, type RunIdentity, type RunRecord, type RunStore, type RunTerminalTransition, type TriggerDefinition, type WorkItem, type WorkSource, type WorkspaceProvider } from "../src/domain/index.js";

const repository: RepositoryScope = { id: "frontend", root: "/repo/frontend" };
const trigger: TriggerDefinition = { id: "ready", sourceId: "queue", repository, enabled: true, maxConcurrent: 2, agent: { id: "codex", model: "fast" } };
const items: WorkItem[] = [1, 2, 3].map((id) => ({ sourceId: "queue", id: `TASK-${id}`, title: `Task ${id}`, state: "open" }));

class MemoryStore implements RunStore {
  runs = new Map<string, RunRecord>();
  async findActive(identity: RunIdentity) { const run = this.runs.get(createRunKey(identity)); return run && isActiveRun(run.status) ? run : undefined; }
  async countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">) { return [...this.runs.values()].filter((run) => isActiveRun(run.status) && run.identity.repository.id === identity.repository.id && run.identity.sourceId === identity.sourceId && run.identity.triggerId === identity.triggerId).length; }
  async claim(claim: RunClaim) {
    const id = createRunKey(claim.identity);
    if (await this.findActive(claim.identity)) return undefined;
    if (await this.countActive(claim.identity) >= claim.maxConcurrent) return undefined;
    const { maxConcurrent: _maxConcurrent, ...runClaim } = claim;
    const run: RunRecord = { ...runClaim, id, status: "claimed", updatedAt: claim.claimedAt };
    this.runs.set(id, run);
    return run;
  }
  async finishActive(identity: RunIdentity, claimedAt: string, transition: RunTerminalTransition) {
    const run = this.runs.get(createRunKey(identity));
    if (!run || !isActiveRun(run.status) || run.claimedAt !== claimedAt) return undefined;
    const finished: RunRecord = { ...run, status: transition.status, error: transition.error, completedAt: transition.completedAt, updatedAt: transition.completedAt };
    this.runs.set(finished.id, finished);
    return finished;
  }
  async markWorkspaceCleaned(identity: RunIdentity, claimedAt: string, cleanedAt: string) {
    const run = this.runs.get(createRunKey(identity));
    if (!run || run.claimedAt !== claimedAt) return undefined;
    const cleaned: RunRecord = { ...run, workspaceCleanedAt: cleanedAt, updatedAt: cleanedAt };
    this.runs.set(cleaned.id, cleaned);
    return cleaned;
  }
  async update(run: RunRecord) { this.runs.set(run.id, structuredClone(run)); }
  async listActive(scope: RepositoryScope) { return [...this.runs.values()].filter((run) => run.identity.repository.id === scope.id && isActiveRun(run.status)); }
}

const logger: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe("TaskRelay", () => {
  it("claims only the remaining trigger capacity and does not duplicate active work", async () => {
    const store = new MemoryStore();
    const launched: string[] = [];
    const source: WorkSource = { id: "queue", discover: async () => items, report: async () => {} };
    const workspace: WorkspaceProvider = { provision: async (run) => ({ path: `/work/${run.item.id}`, branch: `relay/${run.item.id}` }) };
    const agent: AgentLauncher = {
      resolve: async (profile): Promise<AgentResolution> => ({ agentId: profile?.id || "codex", model: profile?.model }),
      launch: async (spec) => { launched.push(spec.item.id); return { id: spec.item.id, startedAt: "2026-08-15T00:00:00.000Z" }; },
    };
    const relay = new TaskRelay({ triggers: { list: async () => [trigger] }, sources: [source], runStore: store, workspaceProvider: workspace, agentLauncher: agent, logger });

    const first = await relay.tick();
    expect(first.runsLaunched).toBe(2);
    expect(first.skipped).toBe(1);
    expect(launched).toEqual(["TASK-1", "TASK-2"]);

    const second = await relay.tick();
    expect(second.runsLaunched).toBe(0);
    expect(launched).toHaveLength(2);
  });

  it("does not launch when the source cannot persist the claim", async () => {
    const store = new MemoryStore();
    let launches = 0;
    const source: WorkSource = { id: "queue", discover: async () => [items[0]], report: async (event) => { if (event.type === "claimed") throw new Error("claim failed"); } };
    const relay = new TaskRelay({
      triggers: { list: async () => [trigger] },
      sources: [source],
      runStore: store,
      workspaceProvider: { provision: async () => ({ path: "/work" }) },
      agentLauncher: { resolve: async () => ({ agentId: "codex" }), launch: async () => { launches += 1; return { id: "worker", startedAt: "now" }; } },
      logger,
    });
    const result = await relay.tick();
    expect(result.runsLaunched).toBe(0);
    expect(launches).toBe(0);
    expect([...store.runs.values()][0]?.status).toBe("failed");
  });

  it("marks an exited worker succeeded and frees its trigger slot", async () => {
    const store = new MemoryStore();
    let phase = 0;
    let completeWorker: (() => void) | undefined;
    const source: WorkSource = {
      id: "queue",
      discover: async () => phase === 0 ? [items[0]] : [items[1]],
      report: async () => {},
    };
    const agent: AgentLauncher = {
      resolve: async () => ({ agentId: "codex" }),
      launch: async (spec) => ({ id: spec.item.id, startedAt: "now" }),
      wait: async () => new Promise((resolve) => { completeWorker = () => resolve({ status: "succeeded" }); }),
    };
    const relay = new TaskRelay({
      triggers: { list: async () => [{ ...trigger, maxConcurrent: 1 }] },
      sources: [source],
      runStore: store,
      workspaceProvider: { provision: async () => ({ path: "/work" }) },
      agentLauncher: agent,
      logger,
    });

    expect((await relay.tick()).runsLaunched).toBe(1);
    await vi.waitFor(() => expect(completeWorker).toBeTypeOf("function"));
    completeWorker?.();
    await vi.waitFor(() => expect([...store.runs.values()][0]?.status).toBe("succeeded"));
    phase = 1;
    expect((await relay.tick()).runsLaunched).toBe(1);
  });

  it("reconciles a persisted pre-launch run after a relay restart", async () => {
    const store = new MemoryStore();
    const stale: RunRecord = {
      id: createRunKey({ repository, sourceId: "queue", itemId: "TASK-stale", triggerId: "ready" }),
      identity: { repository, sourceId: "queue", itemId: "TASK-stale", triggerId: "ready" },
      item: { sourceId: "queue", id: "TASK-stale", title: "Stale" },
      trigger,
      agent: { agentId: "codex" },
      status: "provisioning",
      claimedAt: "earlier",
      updatedAt: "earlier",
    };
    store.runs.set(stale.id, stale);
    const reports: string[] = [];
    const source: WorkSource = { id: "queue", discover: async () => [], report: async (event) => { reports.push(event.type); } };
    const relay = new TaskRelay({
      triggers: { list: async () => [trigger] },
      sources: [source],
      runStore: store,
      workspaceProvider: { provision: async () => ({ path: "/work" }) },
      agentLauncher: { resolve: async () => ({ agentId: "codex" }), launch: async () => ({ id: "worker", startedAt: "now" }) },
      logger,
    });
    await relay.tick();
    expect(store.runs.get(stale.id)?.status).toBe("failed");
    expect(reports).toContain("failed");
  });

  it("does not reconcile a run already observed by this relay", async () => {
    const store = new MemoryStore();
    let completeWorker: (() => void) | undefined;
    let reconcileCalls = 0;
    const source: WorkSource = { id: "queue", discover: async () => [items[0]], report: async () => {} };
    const relay = new TaskRelay({
      triggers: { list: async () => [{ ...trigger, maxConcurrent: 1 }] },
      sources: [source],
      runStore: store,
      workspaceProvider: { provision: async () => ({ path: "/work" }) },
      agentLauncher: {
        resolve: async () => ({ agentId: "codex" }),
        launch: async () => ({ id: "worker", startedAt: "now" }),
        wait: async () => new Promise((resolve) => { completeWorker = () => resolve({ status: "succeeded" }); }),
        reconcile: async () => { reconcileCalls += 1; return { status: "failed", error: "should not run" }; },
      },
      logger,
    });

    await relay.tick();
    await vi.waitFor(() => expect(completeWorker).toBeTypeOf("function"));
    await relay.tick();
    expect(reconcileCalls).toBe(0);
    expect([...store.runs.values()][0]?.status).toBe("running");
    completeWorker?.();
    await vi.waitFor(() => expect([...store.runs.values()][0]?.status).toBe("succeeded"));
  });

  it("keeps sources open for direct completion reports but not persistent workers", async () => {
    const directStore = new MemoryStore();
    const directOrder: string[] = [];
    let completeDirect: (() => void) | undefined;
    const directSource: WorkSource = {
      id: "queue",
      discover: async () => [items[0]],
      report: async (event) => { directOrder.push(event.type); },
      close: async () => { directOrder.push("close"); },
    };
    const directRelay = new TaskRelay({
      triggers: { list: async () => [{ ...trigger, maxConcurrent: 1 }] },
      sources: [directSource],
      runStore: directStore,
      workspaceProvider: { provision: async () => ({ path: "/work" }) },
      agentLauncher: {
        resolve: async () => ({ agentId: "codex" }),
        launch: async () => ({ id: "direct", startedAt: "now" }),
        wait: async () => new Promise((resolve) => { completeDirect = () => resolve({ status: "succeeded" }); }),
      },
      logger,
    });
    await directRelay.tick();
    await vi.waitFor(() => expect(completeDirect).toBeTypeOf("function"));
    const stoppingDirect = directRelay.stop();
    await Promise.resolve();
    expect(directOrder).not.toContain("close");
    completeDirect?.();
    await stoppingDirect;
    expect(directOrder).toEqual(expect.arrayContaining(["succeeded", "close"]));
    expect(directOrder.indexOf("succeeded")).toBeLessThan(directOrder.indexOf("close"));

    const persistentStore = new MemoryStore();
    const persistentOrder: string[] = [];
    const persistentSource: WorkSource = {
      id: "queue",
      discover: async () => [items[1]],
      report: async (event) => { persistentOrder.push(event.type); },
      close: async () => { persistentOrder.push("close"); },
    };
    const persistentRelay = new TaskRelay({
      triggers: { list: async () => [{ ...trigger, maxConcurrent: 1 }] },
      sources: [persistentSource],
      runStore: persistentStore,
      workspaceProvider: { provision: async () => ({ path: "/work" }) },
      agentLauncher: {
        resolve: async () => ({ agentId: "codex" }),
        launch: async () => ({ id: "tmux", startedAt: "now", metadata: { persistent: true } }),
        wait: async () => new Promise(() => {}),
      },
      logger,
    });
    await persistentRelay.tick();
    await persistentRelay.stop();
    expect(persistentOrder).toContain("close");
  });

  it("does not overwrite or double-report a cleanup terminal transition", async () => {
    const store = new MemoryStore();
    const reports: string[] = [];
    let completeWorker: (() => void) | undefined;
    const source: WorkSource = { id: "queue", discover: async () => [items[0]], report: async (event) => { reports.push(event.type); } };
    const relay = new TaskRelay({
      triggers: { list: async () => [{ ...trigger, maxConcurrent: 1 }] },
      sources: [source],
      runStore: store,
      workspaceProvider: { provision: async () => ({ path: "/work" }) },
      agentLauncher: {
        resolve: async () => ({ agentId: "codex" }),
        launch: async () => ({ id: "worker", startedAt: "now" }),
        wait: async () => new Promise((resolve) => { completeWorker = () => resolve({ status: "succeeded" }); }),
      },
      logger,
    });
    await relay.tick();
    await vi.waitFor(() => expect(completeWorker).toBeTypeOf("function"));
    const active = [...store.runs.values()][0]!;
    const stopped = await store.finishActive(active.identity, active.claimedAt, { status: "stopped", completedAt: "cleanup" });
    expect(stopped?.status).toBe("stopped");
    if (stopped) await source.report({ type: "stopped", sourceId: source.id, run: stopped, occurredAt: "cleanup" });
    completeWorker?.();
    await vi.waitFor(() => expect(store.runs.get(active.id)?.status).toBe("stopped"));
    expect(reports.filter((type) => type === "stopped")).toHaveLength(1);
    expect(reports).not.toContain("succeeded");
  });
});
