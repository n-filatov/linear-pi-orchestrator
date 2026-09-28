import { describe, expect, it, vi } from "vitest";
import {
  createRunKey,
  type AgentLauncher,
  type RelayLogger,
  type RunIdentity,
  type RunRecord,
  type RunStore,
  type TriggerDefinition,
  type WorkItem,
  type WorkerChildHandle,
  type WorkerRuntime,
  type WorkSource,
  type WorkspaceProvider,
} from "@task-relay/domain";
import { ManageWorkers } from "../src/index.js";

const repository = { id: "workers", root: "/repo/workers" };
const item: WorkItem = { sourceId: "queue", id: "WORK-1", title: "Implement lifecycle" };
const trigger: TriggerDefinition = { id: "implement", sourceId: item.sourceId, repository, enabled: true };
const logger: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} };

class WorkerStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();

  async findActive(identity: RunIdentity): Promise<RunRecord | undefined> {
    return this.runs.get(createRunKey(identity));
  }

  async countActive(): Promise<number> { return 0; }

  async claim(): Promise<RunRecord | undefined> { return undefined; }

  async finishActive(identity: RunIdentity, claimedAt: string, transition: { status: "succeeded" | "failed" | "stopped"; completedAt: string; error?: string }): Promise<RunRecord | undefined> {
    const current = this.runs.get(createRunKey(identity));
    if (!current || current.claimedAt !== claimedAt) return undefined;
    const next = { ...current, ...transition, updatedAt: transition.completedAt };
    this.runs.set(next.id, next);
    return next;
  }

  async markWorkspaceCleaned(identity: RunIdentity, claimedAt: string, cleanedAt: string): Promise<RunRecord | undefined> {
    const current = this.runs.get(createRunKey(identity));
    if (!current || current.claimedAt !== claimedAt) return undefined;
    const next = { ...current, workspaceCleanedAt: cleanedAt, updatedAt: cleanedAt };
    this.runs.set(next.id, next);
    return next;
  }

  async update(run: RunRecord): Promise<void> { this.runs.set(run.id, run); }

  async recordWorkerChild(identity: RunIdentity, claimedAt: string, child: WorkerChildHandle, recordedAt: string): Promise<RunRecord | undefined> {
    const current = this.runs.get(createRunKey(identity));
    if (!current?.worker || current.claimedAt !== claimedAt) return undefined;
    const children = Array.isArray(current.worker.metadata?.children) ? current.worker.metadata.children : [];
    const next = { ...current, worker: { ...current.worker, metadata: { ...current.worker.metadata, children: [...children, child] } }, updatedAt: recordedAt };
    this.runs.set(next.id, next);
    return next;
  }

  async recordWorkerOutputs(identity: RunIdentity, claimedAt: string, outputs: Record<string, unknown>, recordedAt: string): Promise<RunRecord | undefined> {
    const current = this.runs.get(createRunKey(identity));
    if (!current?.worker || current.claimedAt !== claimedAt) return undefined;
    const previous = current.worker.metadata?.outputs;
    const values = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
    const next = { ...current, worker: { ...current.worker, metadata: { ...current.worker.metadata, outputs: { ...values, ...outputs } } }, updatedAt: recordedAt };
    this.runs.set(next.id, next);
    return next;
  }

  async findWorkerTargets(query: { repository: typeof repository; sourceId?: string; itemId?: string; workerIds?: readonly string[]; includeCleaned?: boolean }): Promise<readonly RunRecord[]> {
    const ids = new Set(query.workerIds ?? []);
    return [...this.runs.values()].filter((run) => run.identity.repository.id === query.repository.id
      && (!query.sourceId || run.identity.sourceId === query.sourceId)
      && (!query.itemId || run.identity.itemId === query.itemId)
      && (!ids.size || ids.has(run.worker?.id ?? ""))
      && (query.includeCleaned || !run.workspaceCleanedAt));
  }

  async findRunsForItem(query: { repository: typeof repository; sourceId: string; itemId: string }): Promise<readonly RunRecord[]> {
    return this.findWorkerTargets(query);
  }
}

function workerRun(): RunRecord {
  const identity = { repository, sourceId: item.sourceId, itemId: item.id, triggerId: trigger.id };
  return {
    id: createRunKey(identity), identity, item, trigger, agent: { agentId: "codex" },
    status: "running", claimedAt: "2026-09-06T10:00:00.000Z", updatedAt: "2026-09-06T10:00:00.000Z",
    workspace: { path: "/repo/workers/.task-relay/WORK-1" }, worker: { id: "worker-1", startedAt: "2026-09-06T10:00:00.000Z" },
  };
}

function subject(input: { store: WorkerStore; runtime: WorkerRuntime; source?: WorkSource; launcher?: Partial<AgentLauncher>; workspace?: WorkspaceProvider }): ManageWorkers {
  return new ManageWorkers({
    sources: [input.source ?? { id: item.sourceId, discover: async () => [], report: async () => {} }],
    runStore: input.store,
    workspaceProvider: input.workspace ?? { provision: async () => ({ path: "/unused" }) },
    agentLauncher: {
      resolve: async () => ({ agentId: "codex" }), launch: async () => ({ id: "unused", startedAt: "now" }), runtime: input.runtime,
      ...input.launcher,
    },
    logger,
    now: () => new Date("2026-09-06T12:00:00.000Z"),
  });
}

describe("ManageWorkers", () => {
  it("keeps worker controls in the same runtime pane and records their durable state", async () => {
    const store = new WorkerStore();
    store.runs.set(workerRun().id, workerRun());
    const child = { id: "pane-2", kind: "pane" as const, target: "%2", command: "npm", startedAt: "now" };
    const runtime: WorkerRuntime = {
      capabilities: { children: true, input: true, capture: true }, open: vi.fn(async () => child),
      sendInput: vi.fn(async () => {}), capture: vi.fn(async () => "test output"), exists: vi.fn(async () => true), closeChild: vi.fn(async () => {}),
    };
    const workers = subject({ store, runtime });

    await expect(workers.exec(trigger, item, {}, { workerId: "worker-1" }, { command: "npm", args: ["run", "dev"], open: "pane" }))
      .resolves.toMatchObject({ status: "succeeded", output: { children: [child], target: "pane" } });
    await expect(workers.send(trigger, item, {}, { workerId: "worker-1" }, { text: "continue" }))
      .resolves.toMatchObject({ status: "succeeded", output: { workerIds: ["worker-1"], submitted: true } });
    await expect(workers.capture(trigger, item, {}, { workerId: "worker-1" }, { child: "%2", lines: 40 }))
      .resolves.toEqual({ status: "succeeded", output: { captured: { "worker-1": "test output" } } });
    await expect(workers.recordOutputs(trigger, item, {}, { workerId: "worker-1" }, { reviewed: true }))
      .resolves.toMatchObject({ status: "succeeded", output: { workerIds: ["worker-1"], outputs: { reviewed: true } } });

    expect(runtime.open).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-1" }), expect.objectContaining({ open: "pane" }));
    expect(runtime.sendInput).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-1" }), { text: "continue" });
    expect(runtime.capture).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-1" }), { child: "%2", lines: 40 });
    expect(store.runs.get(workerRun().id)?.worker?.metadata).toMatchObject({ children: [child], outputs: { reviewed: true } });
  });

  it("stops, cleans, and reports the exact selected worker generation", async () => {
    const store = new WorkerStore();
    const run = workerRun();
    store.runs.set(run.id, run);
    const stop = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    const report = vi.fn(async () => {});
    const runtime: WorkerRuntime = { capabilities: { children: true, input: true, capture: true }, open: vi.fn(), sendInput: vi.fn(), capture: vi.fn(), exists: vi.fn(), closeChild: vi.fn() };
    const source: WorkSource = { id: item.sourceId, discover: async () => [], report };
    const workers = subject({ store, runtime, launcher: { stop }, workspace: { provision: async () => ({ path: "/unused" }), cleanup }, source });

    await expect(workers.cleanup(source, trigger, item, "worker-1")).resolves.toMatchObject({ status: "succeeded", output: { workerId: "worker-1", runId: run.id, workspace: run.workspace?.path } });
    expect(stop).toHaveBeenCalledWith(run.worker, run);
    expect(cleanup).toHaveBeenCalledWith(run.workspace, run);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ type: "stopped", run: expect.objectContaining({ id: run.id }) }));
    expect(store.runs.get(run.id)).toMatchObject({ status: "stopped", workspaceCleanedAt: "2026-09-06T12:00:00.000Z" });
  });

  describe("prompt, turn, and handoff", () => {
    const runtime: WorkerRuntime = { capabilities: { children: true, input: true, capture: true }, open: vi.fn(), sendInput: vi.fn(), capture: vi.fn(), exists: vi.fn(), closeChild: vi.fn() };

    it("starts a turn through the agent launcher for exactly one resolved worker", async () => {
      const store = new WorkerStore();
      store.runs.set(workerRun().id, workerRun());
      const sendPrompt = vi.fn(async () => ({ workerId: "worker-1", turnId: "turn-1", status: "running" as const }));
      const workers = subject({ store, runtime, launcher: { sendPrompt } });

      await expect(workers.prompt(trigger, item, {}, { workerId: "worker-1" }, { prompt: "continue" }))
        .resolves.toEqual({ workerId: "worker-1", turnId: "turn-1", status: "running" });
      expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-1" }), expect.objectContaining({ id: workerRun().id }), { prompt: "continue" });
    });

    it("throws when the launcher cannot send a prompt", async () => {
      const store = new WorkerStore();
      store.runs.set(workerRun().id, workerRun());
      const workers = subject({ store, runtime });

      await expect(workers.prompt(trigger, item, {}, { workerId: "worker-1" }, { prompt: "continue" }))
        .rejects.toThrow(/cannot send a prompt/);
    });

    it("throws when the reference does not resolve to exactly one worker", async () => {
      const store = new WorkerStore();
      const workers = subject({ store, runtime, launcher: { sendPrompt: vi.fn() } });

      await expect(workers.prompt(trigger, item, {}, { workerId: "missing" }, { prompt: "continue" }))
        .rejects.toThrow(/exactly one worker/);
    });

    it("reads a turn's state for a worker whose run is still active", async () => {
      const store = new WorkerStore();
      const run = workerRun();
      store.runs.set(run.id, run);
      expect(run.status).toBe("running");
      const turn = vi.fn(async () => ({ workerId: "worker-1", turnId: "turn-1", status: "succeeded" as const, result: "done" }));
      const workers = subject({ store, runtime, launcher: { turn } });

      await expect(workers.turn(trigger, item, {}, { workerId: "worker-1" }, "turn-1"))
        .resolves.toEqual({ workerId: "worker-1", turnId: "turn-1", status: "succeeded", result: "done" });
      expect(turn).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-1" }), expect.objectContaining({ id: run.id }), "turn-1");
    });

    it("throws when the launcher cannot read a worker turn", async () => {
      const store = new WorkerStore();
      store.runs.set(workerRun().id, workerRun());
      const workers = subject({ store, runtime });

      await expect(workers.turn(trigger, item, {}, { workerId: "worker-1" }, "turn-1")).rejects.toThrow(/cannot read a worker turn/);
    });

    it("settles a turn as failed instead of throwing when the worker no longer resolves", async () => {
      const store = new WorkerStore();
      const workers = subject({ store, runtime, launcher: { turn: vi.fn() } });

      await expect(workers.turn(trigger, item, {}, { workerId: "worker-1" }, "turn-1"))
        .resolves.toEqual({ workerId: "worker-1", turnId: "turn-1", status: "failed", error: "The session worker is no longer running." });
    });

    it("settles a turn as failed instead of asking the launcher when the run is no longer active", async () => {
      const store = new WorkerStore();
      const run = { ...workerRun(), status: "stopped" as const };
      store.runs.set(run.id, run);
      const turn = vi.fn();
      const workers = subject({ store, runtime, launcher: { turn } });

      await expect(workers.turn(trigger, item, {}, { workerId: "worker-1" }, "turn-1"))
        .resolves.toEqual({ workerId: "worker-1", turnId: "turn-1", status: "failed", error: "The session worker is no longer running." });
      expect(turn).not.toHaveBeenCalled();
    });

    it("records handoff outputs and finishes an active run as succeeded", async () => {
      const store = new WorkerStore();
      const run = workerRun();
      store.runs.set(run.id, run);
      const report = vi.fn(async () => {});
      const source: WorkSource = { id: item.sourceId, discover: async () => [], report };
      const handoffResult = { target: "claude-app", handedOffAt: "2026-09-06T12:00:00.000Z", chainStatus: "succeeded" as const, link: "claude://claude.ai/epitaxy/local_1" };
      const handoff = vi.fn(async () => handoffResult);
      const workers = subject({ store, runtime, launcher: { handoff }, source });

      await expect(workers.handoff(source, trigger, item, {}, { workerId: "worker-1" })).resolves.toEqual(handoffResult);

      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-1" }), expect.objectContaining({ id: run.id }), undefined);
      expect(store.runs.get(run.id)?.worker?.metadata?.outputs).toMatchObject({ claudeSession: handoffResult });
      expect(store.runs.get(run.id)?.status).toBe("succeeded");
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ type: "succeeded", run: expect.objectContaining({ id: run.id }) }));
    });

    it("finishes an active run as failed when the handoff chain failed", async () => {
      const store = new WorkerStore();
      const run = workerRun();
      store.runs.set(run.id, run);
      const source: WorkSource = { id: item.sourceId, discover: async () => [], report: async () => {} };
      const handoffResult = { target: "claude-app", handedOffAt: "2026-09-06T12:00:00.000Z", chainStatus: "failed" as const };
      const workers = subject({ store, runtime, launcher: { handoff: vi.fn(async () => handoffResult) }, source });

      await expect(workers.handoff(source, trigger, item, {}, { workerId: "worker-1" })).resolves.toEqual(handoffResult);
      expect(store.runs.get(run.id)?.status).toBe("failed");
    });

    it("does not re-finish a run that has already reached a terminal status", async () => {
      const store = new WorkerStore();
      const run = { ...workerRun(), status: "succeeded" as const, completedAt: "2026-09-06T11:00:00.000Z" };
      store.runs.set(run.id, run);
      const report = vi.fn(async () => {});
      const source: WorkSource = { id: item.sourceId, discover: async () => [], report };
      const handoffResult = { target: "claude-app", handedOffAt: "2026-09-06T12:00:00.000Z", chainStatus: "succeeded" as const };
      const workers = subject({ store, runtime, launcher: { handoff: vi.fn(async () => handoffResult) }, source });

      await workers.handoff(source, trigger, item, {}, { workerId: "worker-1" });

      expect(report).not.toHaveBeenCalled();
      expect(store.runs.get(run.id)?.completedAt).toBe("2026-09-06T11:00:00.000Z");
    });

    it("throws when the launcher cannot hand off a worker", async () => {
      const store = new WorkerStore();
      store.runs.set(workerRun().id, workerRun());
      const source: WorkSource = { id: item.sourceId, discover: async () => [], report: async () => {} };
      const workers = subject({ store, runtime, source });

      await expect(workers.handoff(source, trigger, item, {}, { workerId: "worker-1" })).rejects.toThrow(/cannot hand off/);
    });
  });
});
