import { describe, expect, it } from "vitest";
import { z } from "zod";
import { builtInActionPlugins } from "../src/actions/builtins.js";
import { type ActionInvocationStore, TaskRelay } from "../src/core/task-relay.js";
import {
  createRunKey,
  isActiveRun,
  type AgentLauncher,
  type RelayLogger,
  type RepositoryScope,
  type RunClaim,
  type RunIdentity,
  type RunRecord,
  type RunStore,
  type RunTerminalTransition,
  type TriggerDefinition,
  type WorkItem,
  type WorkSource,
  type WorkspaceProvider,
} from "../src/domain/index.js";
import { RelayPluginRegistry, type ActionPlugin } from "../src/plugins/index.js";

const repository: RepositoryScope = { id: "actions", root: "/repo/actions" };
const logger: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} };

class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();

  async findActive(identity: RunIdentity): Promise<RunRecord | undefined> {
    const run = this.runs.get(createRunKey(identity));
    return run && isActiveRun(run.status) ? run : undefined;
  }

  async countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">): Promise<number> {
    return [...this.runs.values()].filter((run) => isActiveRun(run.status)
      && sameRepository(run.identity.repository, identity.repository)
      && run.identity.sourceId === identity.sourceId
      && run.identity.triggerId === identity.triggerId).length;
  }

  async claim(claim: RunClaim): Promise<RunRecord | undefined> {
    const id = createRunKey(claim.identity);
    if (await this.findActive(claim.identity) || await this.countActive(claim.identity) >= claim.maxConcurrent) return undefined;
    const { maxConcurrent: _maxConcurrent, ...rest } = claim;
    const run: RunRecord = { ...rest, id, status: "claimed", updatedAt: claim.claimedAt };
    this.runs.set(id, run);
    return run;
  }

  async finishActive(identity: RunIdentity, claimedAt: string, transition: RunTerminalTransition): Promise<RunRecord | undefined> {
    const run = this.runs.get(createRunKey(identity));
    if (!run || !isActiveRun(run.status) || run.claimedAt !== claimedAt) return undefined;
    const finished: RunRecord = { ...run, status: transition.status, completedAt: transition.completedAt, updatedAt: transition.completedAt, error: transition.error };
    this.runs.set(finished.id, finished);
    return finished;
  }

  async markWorkspaceCleaned(identity: RunIdentity, claimedAt: string, cleanedAt: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(createRunKey(identity));
    if (!run || run.claimedAt !== claimedAt) return undefined;
    const cleaned = { ...run, workspaceCleanedAt: cleanedAt, updatedAt: cleanedAt };
    this.runs.set(cleaned.id, cleaned);
    return cleaned;
  }

  async update(run: RunRecord): Promise<void> { this.runs.set(run.id, structuredClone(run)); }

  async listActive(scope: RepositoryScope): Promise<readonly RunRecord[]> {
    return [...this.runs.values()].filter((run) => sameRepository(run.identity.repository, scope) && isActiveRun(run.status));
  }

  async findWorkerTargets(query: {
    repository: RepositoryScope;
    sourceId?: string;
    itemId?: string;
    selection?: "latest" | "active" | "all";
    workerIds?: readonly string[];
    includeCleaned?: boolean;
  }): Promise<readonly RunRecord[]> {
    const ids = new Set(query.workerIds ?? []);
    const runs = [...this.runs.values()]
      .filter((run) => sameRepository(run.identity.repository, query.repository) && Boolean(run.worker))
      .filter((run) => query.includeCleaned || !run.workspaceCleanedAt)
      .filter((run) => !query.sourceId || run.identity.sourceId === query.sourceId)
      .filter((run) => !query.itemId || run.identity.itemId === query.itemId)
      .filter((run) => ids.size === 0 || ids.has(run.worker!.id))
      .sort((left, right) => right.claimedAt.localeCompare(left.claimedAt));
    if (query.selection === "active") return runs.filter((run) => isActiveRun(run.status));
    return query.selection === "latest" ? runs.slice(0, 1) : runs;
  }
}

class MemoryActionLedger implements ActionInvocationStore {
  readonly records = new Map<string, { status: "running" | "succeeded" | "failed" | "skipped"; claimedAt: string; output?: unknown; error?: unknown }>();

  async claimActionExecution(claim: { idempotencyKey: string; claimedAt: string }): Promise<{ claimedAt: string } | undefined> {
    const previous = this.records.get(claim.idempotencyKey);
    if (previous?.status === "running" || previous?.status === "succeeded") return undefined;
    this.records.set(claim.idempotencyKey, { status: "running", claimedAt: claim.claimedAt });
    return { claimedAt: claim.claimedAt };
  }

  async finishActionExecution(id: string, claimedAt: string, transition: { status: "succeeded" | "failed" | "skipped"; completedAt: string; output?: unknown; error?: unknown }): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.claimedAt !== claimedAt || record.status !== "running") return;
    this.records.set(id, { status: transition.status, claimedAt, output: transition.output, error: transition.error });
  }
}

function source(items: readonly WorkItem[]): WorkSource {
  return { id: "linear", discover: async () => items, report: async () => {} };
}

function baseTrigger(actions: TriggerDefinition["actions"]): TriggerDefinition {
  return { id: "cleanup-terminal", sourceId: "linear", repository, enabled: true, actions, targets: { workers: { sourceItem: "current", runs: "all" } } };
}

function relay(input: {
  trigger: TriggerDefinition;
  items: readonly WorkItem[];
  runStore: MemoryRunStore;
  registry: RelayPluginRegistry;
  actionLedger?: MemoryActionLedger;
  agent?: AgentLauncher;
  workspace?: WorkspaceProvider;
}): TaskRelay {
  return new TaskRelay({
    triggers: { list: async () => [input.trigger] },
    sources: [source(input.items)],
    runStore: input.runStore,
    workspaceProvider: input.workspace ?? { provision: async () => ({ path: "/workspace" }) },
    agentLauncher: input.agent ?? { resolve: async () => ({ agentId: "codex" }), launch: async () => ({ id: "unused", startedAt: "now" }) },
    actionPlugins: input.registry,
    actionExecutions: input.actionLedger,
    logger,
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  });
}

describe("generic action execution", () => {
  it("executes cleanup for a terminal item and resolves the worker from a different launch trigger", async () => {
    const store = new MemoryRunStore();
    const item: WorkItem = { sourceId: "linear", id: "ENG-123", title: "Done", terminal: true };
    const launchedTrigger: TriggerDefinition = { id: "implementation", sourceId: "linear", repository, enabled: true };
    const identity = { repository, sourceId: "linear", itemId: item.id, triggerId: launchedTrigger.id };
    const workerRun: RunRecord = {
      id: createRunKey(identity), identity, item, trigger: launchedTrigger, agent: { agentId: "codex" },
      status: "running", claimedAt: "earlier", updatedAt: "earlier",
      workspace: { path: "/workspace/ENG-123" }, worker: { id: "worker-from-implementation", startedAt: "earlier" },
    };
    store.runs.set(workerRun.id, workerRun);
    const stopped: string[] = [];
    const cleaned: string[] = [];
    const receivedWorkerIds: string[] = [];
    const cleanup: ActionPlugin = {
      kind: "action", use: "cleanup-worker", target: "worker", configSchema: z.object({}),
      async execute(context) {
        receivedWorkerIds.push(context.worker!.id);
        return context.workers.cleanup(context.worker!.id);
      },
    };
    const registry = new RelayPluginRegistry().registerAction(cleanup);
    const actionLedger = new MemoryActionLedger();
    const activeRelay = relay({
      trigger: baseTrigger([{ id: "cleanup", use: "cleanup-worker", config: {} }]), items: [item], runStore: store, registry, actionLedger,
      agent: {
        resolve: async () => ({ agentId: "codex" }), launch: async () => ({ id: "unused", startedAt: "now" }),
        stop: async (worker) => { stopped.push(worker.id); },
      },
      workspace: { provision: async () => ({ path: "/workspace" }), cleanup: async (workspace) => { cleaned.push(workspace.path); } },
    });

    const result = await activeRelay.tick();
    expect(result.actionsExecuted).toBe(1);
    expect(receivedWorkerIds).toEqual(["worker-from-implementation"]);
    expect(stopped).toEqual(["worker-from-implementation"]);
    expect(cleaned).toEqual(["/workspace/ENG-123"]);
    expect(store.runs.get(workerRun.id)).toMatchObject({ status: "stopped", workspaceCleanedAt: "2026-08-15T12:00:00.000Z" });
  });

  it("runs ordered custom actions with previous output and does not repeat a successful action", async () => {
    const store = new MemoryRunStore();
    const ledger = new MemoryActionLedger();
    const item: WorkItem = { sourceId: "linear", id: "ENG-124", title: "Notify" };
    const events: string[] = [];
    const first: ActionPlugin = {
      kind: "action", use: "first", configSchema: z.object({}),
      async execute() { events.push("first"); return { status: "succeeded", output: { workerId: "worker-42" } }; },
    };
    const second: ActionPlugin = {
      kind: "action", use: "second", configSchema: z.object({}),
      async execute(context) {
        events.push(`second:${context.outputs.first?.output?.workerId}`);
        return { status: "succeeded", output: { notified: true } };
      },
    };
    const registry = new RelayPluginRegistry().registerAction(first).registerAction(second);
    const activeRelay = relay({
      trigger: baseTrigger([{ id: "first", use: "first", config: {} }, { id: "second", use: "second", config: {} }]), items: [item], runStore: store, registry, actionLedger: ledger,
    });

    const firstResult = await activeRelay.tick();
    expect(firstResult.actionsExecuted).toBe(2);
    expect(events).toEqual(["first", "second:worker-42"]);
    expect((await activeRelay.tick()).actionsExecuted).toBe(0);
    expect(events).toEqual(["first", "second:worker-42"]);
  });

  it("retries failed and skipped actions on a later poll", async () => {
    const store = new MemoryRunStore();
    const ledger = new MemoryActionLedger();
    const item: WorkItem = { sourceId: "linear", id: "ENG-125", title: "Retry" };
    let failures = 0;
    let skips = 0;
    const failing: ActionPlugin = {
      kind: "action", use: "failing", configSchema: z.object({}),
      async execute() { failures += 1; throw new Error("temporary"); },
    };
    const skipped: ActionPlugin = {
      kind: "action", use: "skipped", configSchema: z.object({}),
      async execute() { skips += 1; return { status: "skipped", message: "not ready" }; },
    };
    const registry = new RelayPluginRegistry().registerAction(failing).registerAction(skipped);
    const activeRelay = relay({
      trigger: baseTrigger([
        { id: "failing", use: "failing", config: {}, continueOnError: true },
        { id: "skipped", use: "skipped", config: {} },
      ]), items: [item], runStore: store, registry, actionLedger: ledger,
    });

    await activeRelay.tick();
    await activeRelay.tick();

    expect(failures).toBe(2);
    expect(skips).toBe(2);
  });

  it("stops the remaining action pipeline when continueOnError is false", async () => {
    const store = new MemoryRunStore();
    const ledger = new MemoryActionLedger();
    const item: WorkItem = { sourceId: "linear", id: "ENG-127", title: "Stop pipeline" };
    let afterFailure = 0;
    const failing: ActionPlugin = {
      kind: "action", use: "stop-failure", configSchema: z.object({}),
      async execute() { throw new Error("stop here"); },
    };
    const later: ActionPlugin = {
      kind: "action", use: "must-not-run", configSchema: z.object({}),
      async execute() { afterFailure += 1; return { status: "succeeded" }; },
    };
    const registry = new RelayPluginRegistry().registerAction(failing).registerAction(later);
    const activeRelay = relay({
      trigger: baseTrigger([{ id: "failure", use: "stop-failure" }, { id: "later", use: "must-not-run" }]),
      items: [item], runStore: store, registry, actionLedger: ledger,
    });

    const result = await activeRelay.tick();

    expect(result.actionsFailed).toBe(1);
    expect(afterFailure).toBe(0);
  });

  it("launch action passes harness, model, and custom prompt to the worker launch", async () => {
    const store = new MemoryRunStore();
    const ledger = new MemoryActionLedger();
    const item: WorkItem = { sourceId: "linear", id: "ENG-126", title: "Review" };
    const resolvedProfiles: Array<TriggerDefinition["agent"]> = [];
    const launchedPrompts: string[] = [];
    const agent: AgentLauncher = {
      async resolve(profile) {
        resolvedProfiles.push(profile);
        return { agentId: profile?.id ?? "unknown", model: profile?.model };
      },
      async launch(spec) {
        launchedPrompts.push(spec.trigger.agent?.promptTemplate ?? "");
        return { id: "worker-review", startedAt: "now" };
      },
    };
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);
    const activeRelay = relay({
      trigger: baseTrigger([{ id: "review", use: "launch", config: { harness: "opencode", mode: "interactive", model: "gpt-5.6-terra", prompt: "Review {{item.id}} carefully." } }]),
      items: [item], runStore: store, registry, actionLedger: ledger, agent,
    });

    const result = await activeRelay.tick();

    expect(result.runsLaunched).toBe(1);
    expect(resolvedProfiles).toEqual([{ id: "opencode", model: "gpt-5.6-terra", promptTemplate: "Review {{item.id}} carefully.", metadata: { modelProfile: undefined } }]);
    expect(launchedPrompts).toEqual(["Review {{item.id}} carefully."]);
    expect([...store.runs.values()][0]?.trigger.promptDelivery).toBe("interactive");
  });
});

function sameRepository(left: RepositoryScope, right: RepositoryScope): boolean {
  return left.id === right.id && left.root === right.root;
}
