import { writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  workerChildren,
  type WorkerChildHandle,
  type WorkerChildSpec,
  type WorkerInputSpec,
  type WorkerRuntime,
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

  async recordWorkerChild(identity: RunIdentity, claimedAt: string, child: WorkerChildHandle, recordedAt: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(createRunKey(identity));
    if (!run || run.claimedAt !== claimedAt || !run.worker) return undefined;
    const updated: RunRecord = {
      ...run,
      worker: { ...run.worker, metadata: { ...run.worker.metadata, children: [...workerChildren(run.worker), child] } },
      updatedAt: recordedAt,
    };
    this.runs.set(updated.id, updated);
    return updated;
  }

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

  it("cleans a reopened worker generation even when its worker ID is reused", async () => {
    const store = new MemoryRunStore();
    const item: WorkItem = { sourceId: "linear", id: "ENG-123", title: "Done", terminal: true };
    const launchedTrigger: TriggerDefinition = { id: "implementation", sourceId: "linear", repository, enabled: true };
    const identity = { repository, sourceId: "linear", itemId: item.id, triggerId: launchedTrigger.id };
    const run = (claimedAt: string): RunRecord => ({
      id: createRunKey(identity), identity, item, trigger: launchedTrigger, agent: { agentId: "codex" },
      status: "running", claimedAt, updatedAt: claimedAt,
      workspace: { path: "/workspace/ENG-123" }, worker: { id: "worker-from-implementation", startedAt: claimedAt },
    });
    const cleaned: string[] = [];
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);
    const ledger = new MemoryActionLedger();
    const activeRelay = relay({
      trigger: baseTrigger([{ id: "cleanup", use: "cleanup", config: {} }]), items: [item], runStore: store, registry, actionLedger: ledger,
      agent: { resolve: async () => ({ agentId: "codex" }), launch: async () => ({ id: "unused", startedAt: "now" }), stop: async () => {} },
      workspace: { provision: async () => ({ path: "/workspace" }), cleanup: async (workspace) => { cleaned.push(workspace.path); } },
    });

    const first = run("first");
    store.runs.set(first.id, first);
    await activeRelay.tick();
    const reopened = run("reopened");
    store.runs.set(reopened.id, reopened);
    await activeRelay.tick();

    expect(cleaned).toEqual(["/workspace/ENG-123", "/workspace/ENG-123"]);
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

  it("re-runs an on-change action when Linear supplies a newer issue revision", async () => {
    const store = new MemoryRunStore();
    const ledger = new MemoryActionLedger();
    let item: WorkItem = { sourceId: "linear", id: "ENG-124", title: "Reopen", metadata: { linearUpdatedAt: "2026-08-15T12:00:00.000Z" } };
    let executions = 0;
    const action: ActionPlugin = {
      kind: "action", use: "record", configSchema: z.object({}),
      async execute() { executions += 1; return { status: "succeeded" }; },
    };
    const registry = new RelayPluginRegistry().registerAction(action);
    const activeRelay = new TaskRelay({
      triggers: { list: async () => [{ ...baseTrigger([{ id: "record", use: "record", config: {} }]), firePolicy: "on-change" }] },
      sources: [{ id: "linear", discover: async () => [item], report: async () => {} }],
      runStore: store,
      workspaceProvider: { provision: async () => ({ path: "/workspace" }) },
      agentLauncher: { resolve: async () => ({ agentId: "codex" }), launch: async () => ({ id: "unused", startedAt: "now" }) },
      actionPlugins: registry,
      actionExecutions: ledger,
      logger,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    await activeRelay.tick();
    await activeRelay.tick();
    item = { ...item, metadata: { linearUpdatedAt: "2026-08-15T12:01:00.000Z" } };
    await activeRelay.tick();

    expect(executions).toBe(2);
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

  it("launch action reads promptFile relative to the repository root and passes its content as prompt template", async () => {
    const store = new MemoryRunStore();
    const ledger = new MemoryActionLedger();
    const item: WorkItem = { sourceId: "linear", id: "ENG-999", title: "Prompt file" };
    const tmpDir = await mkdir(path.join(os.tmpdir(), `relay-test-${Date.now()}`), { recursive: true }).then(() => path.join(os.tmpdir(), `relay-test-${Date.now() - 1}`));
    const promptsDir = path.join(os.tmpdir(), `relay-prompts-${Date.now()}`);
    await mkdir(promptsDir, { recursive: true });
    const promptPath = path.join(promptsDir, "implement.md");
    await writeFile(promptPath, "Implement {{key}}: {{title}}\n\n{{description}}", "utf8");
    const launchedPrompts: string[] = [];
    const agent: AgentLauncher = {
      async resolve(profile) { return { agentId: profile?.id ?? "codex" }; },
      async launch(spec) { launchedPrompts.push(spec.trigger.agent?.promptTemplate ?? ""); return { id: "w", startedAt: "now" }; },
    };
    const repoRoot = os.tmpdir();
    const relPath = path.relative(repoRoot, promptPath);
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);
    const activeRelay = new TaskRelay({
      triggers: { list: async () => [{ ...baseTrigger([{ id: "impl", use: "launch", config: { harness: "codex", promptFile: relPath } }]), repository: { id: "r", root: repoRoot } }] },
      sources: [source([item])],
      runStore: store,
      workspaceProvider: { provision: async () => ({ path: "/workspace" }) },
      agentLauncher: agent,
      actionPlugins: registry,
      actionExecutions: ledger,
      logger,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    const result = await activeRelay.tick();

    expect(result.runsLaunched).toBe(1);
    expect(launchedPrompts).toEqual(["Implement {{key}}: {{title}}\n\n{{description}}"]);
    void tmpDir;
  });

  it("launch action rejects config with both prompt and promptFile", () => {
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);
    expect(() => registry.parseActionConfig("launch", { harness: "codex", prompt: "inline", promptFile: "prompts/impl.md" }))
      .toThrow("Specify either 'prompt' or 'promptFile', not both.");
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

describe("worker-scoped actions", () => {
  const item: WorkItem = { sourceId: "linear", id: "ENG-900", title: "Add a dev server" };

  function seededRun(store: MemoryRunStore, options: { workerId: string; branch?: string; claimedAt?: string; triggerId?: string }): RunRecord {
    const identity = { repository, sourceId: "linear", itemId: item.id, triggerId: options.triggerId ?? "implementation" };
    const claimedAt = options.claimedAt ?? "earlier";
    const run: RunRecord = {
      id: createRunKey(identity), identity, item,
      trigger: { id: identity.triggerId, sourceId: "linear", repository, enabled: true },
      agent: { agentId: "codex" }, status: "running", claimedAt, updatedAt: claimedAt,
      workspace: { path: "/workspace/ENG-900", branch: options.branch ?? "relay/ENG-900" },
      worker: { id: options.workerId, startedAt: claimedAt, metadata: { workspace: "/workspace/ENG-900", tmux: { session: "s", target: "@1" } } },
    };
    store.runs.set(run.id, run);
    return run;
  }

  function recordingRuntime() {
    const opened: { worker: string; spec: WorkerChildSpec }[] = [];
    const sent: { worker: string; spec: WorkerInputSpec }[] = [];
    const runtime: WorkerRuntime = {
      capabilities: { children: true, input: true, capture: true },
      async open(worker, spec) {
        opened.push({ worker: worker.id, spec });
        return { id: `${worker.id}:child`, kind: spec.open, target: "%7", name: spec.name, command: spec.command, startedAt: "now" };
      },
      async sendInput(worker, spec) { sent.push({ worker: worker.id, spec }); },
      async capture() { return "captured output"; },
      async exists() { return true; },
      async closeChild() {},
    };
    return { runtime, opened, sent };
  }

  function launcherWith(runtime?: WorkerRuntime): AgentLauncher {
    return { resolve: async () => ({ agentId: "codex" }), launch: async () => ({ id: "unused", startedAt: "now" }), stop: async () => {}, runtime };
  }

  it("opens a pane beside the worker a previous action created and records the child", async () => {
    const store = new MemoryRunStore();
    const run = seededRun(store, { workerId: "worker-implement" });
    const { runtime, opened } = recordingRuntime();
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);
    // Stands in for a launch action: it reports the worker it created.
    registry.registerAction({
      kind: "action", use: "stub-launch", configSchema: z.object({}),
      async execute() { return { status: "succeeded", output: { workerId: "worker-implement", runId: run.id } }; },
    });

    const activeRelay = relay({
      trigger: {
        id: "feature", sourceId: "linear", repository, enabled: true,
        actions: [
          { id: "implement", use: "stub-launch", config: {} },
          { id: "dev-server", use: "worker-exec", config: { worker: { action: "implement" }, open: "pane", name: "dev", command: "npm", args: ["run", "dev"] } },
        ],
      },
      items: [item], runStore: store, registry, actionLedger: new MemoryActionLedger(), agent: launcherWith(runtime),
    });

    const result = await activeRelay.tick();
    expect(result.actionsFailed).toBe(0);
    expect(result.actionsExecuted).toBe(2);
    expect(opened).toEqual([{
      worker: "worker-implement",
      spec: { command: "npm", args: ["run", "dev"], cwd: undefined, env: {}, name: "dev", open: "pane", direction: "vertical" },
    }]);
    expect(store.runs.get(run.id)?.worker?.metadata?.children).toEqual([
      { id: "worker-implement:child", kind: "pane", target: "%7", name: "dev", command: "npm", startedAt: "now" },
    ]);
  });

  it("sends rendered text to the most recent worker for the item", async () => {
    const store = new MemoryRunStore();
    seededRun(store, { workerId: "worker-old", claimedAt: "2026-08-01", triggerId: "old" });
    seededRun(store, { workerId: "worker-new", claimedAt: "2026-08-15", triggerId: "new" });
    const { runtime, sent } = recordingRuntime();
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);

    const activeRelay = relay({
      trigger: {
        id: "ask", sourceId: "linear", repository, enabled: true,
        actions: [{ id: "ask", use: "worker-send", config: { text: "New guidance on {{item.id}}: {{item.title}}" } }],
      },
      items: [item], runStore: store, registry, actionLedger: new MemoryActionLedger(), agent: launcherWith(runtime),
    });

    await activeRelay.tick();
    expect(sent).toEqual([{ worker: "worker-new", spec: { text: "New guidance on ENG-900: Add a dev server", submit: true, child: undefined } }]);
  });

  it("skips instead of failing when no worker matches the reference", async () => {
    const store = new MemoryRunStore();
    const { runtime } = recordingRuntime();
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);
    const ledger = new MemoryActionLedger();

    const activeRelay = relay({
      trigger: {
        id: "ask", sourceId: "linear", repository, enabled: true,
        actions: [{ id: "ask", use: "worker-send", config: { text: "anyone there?" } }],
      },
      items: [item], runStore: store, registry, actionLedger: ledger, agent: launcherWith(runtime),
    });

    const result = await activeRelay.tick();
    expect(result.actionsFailed).toBe(0);
    expect(result.skipped).toBe(1);
    expect([...ledger.records.values()][0]).toMatchObject({ status: "skipped" });
  });

  it("explains that live worker control needs the tmux adapter", async () => {
    const store = new MemoryRunStore();
    seededRun(store, { workerId: "worker-implement" });
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);
    const ledger = new MemoryActionLedger();

    const activeRelay = relay({
      trigger: {
        id: "feature", sourceId: "linear", repository, enabled: true,
        actions: [{ id: "dev-server", use: "worker-exec", config: { command: "npm", args: ["run", "dev"] } }],
      },
      items: [item], runStore: store, registry, actionLedger: ledger, agent: launcherWith(undefined),
    });

    const result = await activeRelay.tick();
    expect(result.actionsFailed).toBe(1);
    expect([...ledger.records.values()][0]?.error).toMatch(/execution\.adapter: tmux/);
  });

  it("pins a launch to the branch of the worker an earlier action created", async () => {
    const store = new MemoryRunStore();
    const run = seededRun(store, { workerId: "worker-implement", branch: "relay/ENG-900-add-a-dev-server" });
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);
    registry.registerAction({
      kind: "action", use: "stub-launch", configSchema: z.object({}),
      async execute() { return { status: "succeeded", output: { workerId: "worker-implement", runId: run.id } }; },
    });
    const provisioned: (string | undefined)[] = [];

    const activeRelay = relay({
      trigger: {
        id: "feature", sourceId: "linear", repository, enabled: true,
        metadata: { branchTemplate: "review/{{key}}" },
        actions: [
          { id: "implement", use: "stub-launch", config: {} },
          { id: "review", use: "launch", config: { harness: "claude", workspace: { fromAction: "implement" } } },
        ],
      },
      items: [item], runStore: store, registry, actionLedger: new MemoryActionLedger(),
      agent: launcherWith(undefined),
      workspace: {
        provision: async (provisioning) => {
          provisioned.push(provisioning.trigger.metadata?.branchTemplate as string | undefined);
          return { path: "/workspace/ENG-900", branch: "relay/ENG-900-add-a-dev-server" };
        },
      },
    });

    const result = await activeRelay.tick();
    expect(result.actionsFailed).toBe(0);
    // The trigger's own template is overridden by the earlier worker's branch,
    // so the review agent lands in the same worktree instead of a new one.
    expect(provisioned).toEqual(["relay/ENG-900-add-a-dev-server"]);
  });
});
