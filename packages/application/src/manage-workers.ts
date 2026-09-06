import type {
  AgentLauncher,
  RepositoryScope,
  RunRecord,
  RunStore,
  SourceEvent,
  TriggerDefinition,
  WorkItem,
  WorkerChildHandle,
  WorkerChildSpec,
  WorkerInputSpec,
  WorkerRuntime,
  WorkSource,
  WorkspaceProvider,
  AgentResolution,
  RelayLogger,
} from "@task-relay/domain";
import { createRunKey, isActiveRun, isTerminalWorkItem, workerChildren } from "@task-relay/domain";
import type {
  ActionResult,
  LaunchWorkerActionRequest,
  ResolvedWorker,
  WorkerRef,
} from "@task-relay/plugin-sdk";

export interface ManageWorkersDependencies {
  sources: Iterable<WorkSource>;
  runStore: RunStore;
  workspaceProvider: WorkspaceProvider;
  agentLauncher: AgentLauncher;
  logger: RelayLogger;
  now?: () => Date;
  oneWorkerPerItem?: boolean;
  validateLaunch?(request: LaunchWorkerActionRequest, context: { triggerId: string; actionId: string }): void;
  /** Repositories are supplied by the trigger provider when shutdown cleanup is requested. */
  listRepositories?: () => Promise<readonly RepositoryScope[]>;
}

export interface DispatchOutcome {
  claimed: boolean;
  launched: boolean;
  skipped: boolean;
  failed?: boolean;
  reason?: string;
  run?: RunRecord;
}

/** Result of a launch action, including the lifecycle transition for host metrics. */
export interface LaunchActionOutcome {
  result: ActionResult;
  dispatch: DispatchOutcome;
  trigger: TriggerDefinition;
}

export interface StopWorkersOptions {
  cleanupActive?: boolean;
}

/**
 * Owns worker lifecycle and runtime verbs. The application layer coordinates
 * durable runs and runtime effects here; TaskRelay only adapts trigger/action
 * results into its polling result shape.
 */
export class ManageWorkers {
  private readonly sources = new Map<string, WorkSource>();
  private readonly now: () => Date;
  private readonly locallyObservedRuns = new Set<string>();
  private readonly nonPersistentObservers = new Set<Promise<void>>();
  private readonly stopController = new AbortController();

  public constructor(private readonly dependencies: ManageWorkersDependencies) {
    for (const source of dependencies.sources) {
      if (this.sources.has(source.id)) throw new Error(`Duplicate work source id: ${source.id}`);
      this.sources.set(source.id, source);
    }
    this.now = dependencies.now ?? (() => new Date());
  }

  public get signal(): AbortSignal {
    return this.stopController.signal;
  }

  public abort(): void {
    this.stopController.abort();
  }

  public source(sourceId: string): WorkSource | undefined {
    return this.sources.get(sourceId);
  }

  public async dispatch(
    source: WorkSource,
    trigger: TriggerDefinition,
    item: WorkItem,
    options: { sidecar?: boolean } = {},
  ): Promise<DispatchOutcome> {
    if (this.signal.aborted || isTerminalWorkItem(item)) {
      return { claimed: false, launched: false, skipped: true, reason: this.signal.aborted ? "Relay is stopping." : "Ticket is terminal." };
    }
    if (item.sourceId !== source.id) {
      this.dependencies.logger.warn("Source returned an item with a mismatched source id", {
        expectedSourceId: source.id, itemSourceId: item.sourceId, itemId: item.id, title: item.title,
      });
      return { claimed: false, launched: false, skipped: true, reason: `Source '${item.sourceId}' does not match '${source.id}'.` };
    }

    const identity = { repository: trigger.repository, sourceId: source.id, itemId: item.id, triggerId: trigger.id };
    const activeRun = await this.dependencies.runStore.findActive(identity);
    if (activeRun) return { claimed: false, launched: false, skipped: true, reason: `Worker ${activeRun.worker?.id ?? "run"} is already active.` };
    const sibling = options.sidecar ? undefined : await this.activeWorkerForItem(trigger, source.id, item.id);
    if (sibling) return { claimed: false, launched: false, skipped: true, reason: `Worker ${sibling.worker?.id ?? sibling.id} is already active for ${item.id}.` };

    let agent: AgentResolution;
    try {
      agent = await this.dependencies.agentLauncher.resolve(trigger.agent, item, trigger);
    } catch (error) {
      this.dependencies.logger.error("Agent resolution failed", { triggerId: trigger.id, itemId: item.id, title: item.title, error: messageFor(error) });
      return { claimed: false, launched: false, skipped: true, reason: `Agent resolution failed: ${messageFor(error)}` };
    }

    const claimedAt = this.now().toISOString();
    const run = await this.dependencies.runStore.claim({
      id: createRunKey(identity), identity, item, trigger, agent, claimedAt,
      maxConcurrent: normaliseConcurrency(trigger.maxConcurrent),
    });
    if (!run) return { claimed: false, launched: false, skipped: true, reason: "Another relay claimed the ticket or the worker limit was reached." };
    if (!await this.report(source, "claimed", run)) {
      run.status = "failed";
      run.error = "Source rejected or failed to persist the claim.";
      run.completedAt = this.now().toISOString();
      run.updatedAt = run.completedAt;
      await this.dependencies.runStore.update(run);
      return { claimed: true, launched: false, skipped: false, failed: true, reason: run.error, run };
    }
    try {
      run.status = "provisioning";
      run.updatedAt = this.now().toISOString();
      await this.dependencies.runStore.update(run);
      await this.report(source, "provisioning", run);
      run.workspace = await this.dependencies.workspaceProvider.provision(run, this.signal);
      run.status = "launching";
      run.updatedAt = this.now().toISOString();
      await this.dependencies.runStore.update(run);
      run.worker = await this.dependencies.agentLauncher.launch({ run, item, trigger, workspace: run.workspace, agent: run.agent, signal: this.signal });
      run.status = "running";
      run.updatedAt = this.now().toISOString();
      await this.dependencies.runStore.update(run);
      await this.report(source, "launched", run);
      this.startObservingWorker(source, run);
      this.dependencies.logger.debug("Task relay launched work", {
        runId: run.id, triggerId: trigger.id, sourceId: source.id, itemId: item.id, title: item.title,
        agentId: run.agent.agentId, model: run.agent.model,
      });
      return { claimed: true, launched: true, skipped: false, run };
    } catch (error) {
      run.status = "failed";
      run.error = messageFor(error);
      run.completedAt = this.now().toISOString();
      run.updatedAt = run.completedAt;
      await this.dependencies.runStore.update(run);
      await this.report(source, "failed", run, run.error);
      this.dependencies.logger.error("Task relay failed to launch work", { runId: run.id, itemId: item.id, title: item.title, error: run.error });
      return { claimed: true, launched: false, skipped: false, failed: true, reason: run.error, run };
    }
  }

  public async launchAction(
    source: WorkSource,
    trigger: TriggerDefinition,
    item: WorkItem,
    actionId: string,
    request: LaunchWorkerActionRequest,
    outputs: Readonly<Record<string, ActionResult>> = {},
  ): Promise<LaunchActionOutcome> {
    this.dependencies.validateLaunch?.(request, { triggerId: trigger.id, actionId });
    const workspace = { ...request.workspace };
    const fromAction = typeof workspace.fromAction === "string" ? workspace.fromAction : undefined;
    if (fromAction) {
      delete workspace.fromAction;
      const branch = await this.branchOfAction(trigger, item, outputs, fromAction);
      if (!branch) return { result: { status: "skipped", message: `Action '${fromAction}' has no workspace to reuse.` }, dispatch: { claimed: false, launched: false, skipped: true }, trigger };
      workspace.branchTemplate = branch;
    }
    const derived: TriggerDefinition = {
      ...trigger, id: `${trigger.id}:${actionId}`, actions: undefined,
      agent: { id: request.harness, model: request.model, promptTemplate: request.prompt,
        metadata: { modelProfile: request.modelProfile, reasoningEffort: request.reasoningEffort, harnessInput: request.harnessInput } },
      promptDelivery: request.mode === "interactive" ? "interactive" : undefined,
      metadata: { ...trigger.metadata, ...workspace },
    };
    const dispatch = await this.dispatch(source, derived, item, { sidecar: request.sidecar === true });
    if (!dispatch.launched) return { result: { status: "skipped", message: dispatch.reason ?? dispatch.run?.error ?? "Worker was not launched." }, dispatch, trigger: derived };
    const codex = dispatch.run?.worker?.metadata?.codexAppServer;
    const codexSession = codex !== null && typeof codex === "object" && !Array.isArray(codex) ? codex as Record<string, unknown> : undefined;
    return { result: { status: "succeeded", output: { runId: dispatch.run?.id, workerId: dispatch.run?.worker?.id,
      ...(typeof codexSession?.threadId === "string" ? { threadId: codexSession.threadId } : {}),
      ...(typeof codexSession?.turnId === "string" ? { turnId: codexSession.turnId } : {}),
      ...(typeof codexSession?.endpoint === "string" ? { endpoint: codexSession.endpoint } : {}),
    } }, dispatch, trigger: derived };
  }

  public async cleanup(source: WorkSource, trigger: TriggerDefinition, item: WorkItem, workerId: string): Promise<ActionResult> {
    const run = (await this.workerTargets(trigger, item, [workerId]))[0];
    if (!run) return { status: "skipped", message: `Worker ${workerId} was not found or was already cleaned.` };
    const wasActive = isActiveRun(run.status);
    const completedAt = this.now().toISOString();
    if (run.worker && (wasActive || run.worker.metadata?.interactive === true)) await this.dependencies.agentLauncher.stop?.(run.worker, run);
    const stopped = wasActive ? await this.dependencies.runStore.finishActive(run.identity, run.claimedAt, { status: "stopped", completedAt }) : undefined;
    const alreadyCleaned = run.workspace && this.dependencies.runStore.findRunsForItem
      ? (await this.dependencies.runStore.findRunsForItem({ repository: trigger.repository, sourceId: item.sourceId, itemId: item.id, selection: "all", includeCleaned: true })).some((candidate) => candidate.id !== run.id && candidate.workspace?.path === run.workspace?.path && Boolean(candidate.workspaceCleanedAt))
      : false;
    if (run.workspace && !alreadyCleaned) await this.dependencies.workspaceProvider.cleanup?.(run.workspace, run);
    const cleaned = await this.dependencies.runStore.markWorkspaceCleaned(run.identity, run.claimedAt, completedAt);
    if (!cleaned) throw new Error(`Workspace was removed, but worker ${workerId} changed before cleanup was recorded.`);
    if (stopped) await this.report(source, "stopped", stopped);
    return { status: "succeeded", output: { workerId, runId: run.id, workspace: run.workspace?.path } };
  }

  public async resolve(trigger: TriggerDefinition, item: WorkItem, outputs: Readonly<Record<string, ActionResult>>, ref: WorkerRef): Promise<readonly ResolvedWorker[]> {
    let workerIds: readonly string[] | undefined;
    let selection: "latest" | "active" | "all" = "all";
    if ("action" in ref) {
      const produced = outputs[ref.action];
      if (!produced) throw new Error(`Action '${ref.action}' has not run before this one in trigger '${trigger.id}'.`);
      const workerId = produced.output?.workerId;
      const producedWorkerIds = produced.output?.workerIds;
      if (typeof workerId === "string") workerIds = [workerId];
      else if (Array.isArray(producedWorkerIds) && producedWorkerIds.every((id): id is string => typeof id === "string")) workerIds = producedWorkerIds;
      else return [];
    } else if ("workerId" in ref) workerIds = [ref.workerId];
    else selection = ref.runs ?? "latest";
    return (await this.workerTargets(trigger, item, workerIds, selection)).filter((run): run is RunRecord & { worker: NonNullable<RunRecord["worker"]> } => Boolean(run.worker)).map((run) => ({ worker: run.worker, run }));
  }

  /** Select persisted worker runs using the trigger-wide target selector. */
  public async targetRuns(
    trigger: TriggerDefinition,
    item: WorkItem,
    explicitWorkerIds?: readonly string[],
    selection?: "latest" | "active" | "all",
  ): Promise<readonly RunRecord[]> {
    return this.workerTargets(trigger, item, explicitWorkerIds, selection);
  }

  public async exec(trigger: TriggerDefinition, item: WorkItem, outputs: Readonly<Record<string, ActionResult>>, ref: WorkerRef, spec: WorkerChildSpec): Promise<ActionResult> {
    const runtime = this.requireRuntime(`open a ${spec.open} beside a worker`);
    const targets = await this.resolve(trigger, item, outputs, ref);
    if (targets.length === 0) return { status: "skipped", message: "No matching worker is running." };
    const opened: WorkerChildHandle[] = [];
    for (const { worker, run } of targets) {
      const child = await runtime.open(worker, spec);
      opened.push(child);
      const recorded = await this.dependencies.runStore.recordWorkerChild?.(run.identity, run.claimedAt, child, this.now().toISOString());
      if (recorded === undefined && !this.dependencies.runStore.recordWorkerChild) {
        run.worker = { ...worker, metadata: { ...worker.metadata, children: [...workerChildren(worker), child] } };
        run.updatedAt = this.now().toISOString();
        await this.dependencies.runStore.update(run);
      } else if (!recorded) this.dependencies.logger.warn("Opened a worker child, but the run changed before it could be recorded", { triggerId: trigger.id, itemId: item.id, workerId: worker.id, child: child.target });
    }
    return { status: "succeeded", output: { children: opened, target: spec.open } };
  }

  public async send(trigger: TriggerDefinition, item: WorkItem, outputs: Readonly<Record<string, ActionResult>>, ref: WorkerRef, spec: WorkerInputSpec): Promise<ActionResult> {
    const runtime = this.requireRuntime("send input to a worker");
    const targets = await this.resolve(trigger, item, outputs, ref);
    if (targets.length === 0) return { status: "skipped", message: "No matching worker is running." };
    for (const { worker } of targets) await runtime.sendInput(worker, spec);
    return { status: "succeeded", output: { workerIds: targets.map(({ worker }) => worker.id), submitted: spec.submit !== false } };
  }

  public async capture(trigger: TriggerDefinition, item: WorkItem, outputs: Readonly<Record<string, ActionResult>>, ref: WorkerRef, options?: { child?: string; lines?: number }): Promise<ActionResult> {
    const runtime = this.requireRuntime("read a worker's output");
    const targets = await this.resolve(trigger, item, outputs, ref);
    if (targets.length === 0) return { status: "skipped", message: "No matching worker is running." };
    const captured: Record<string, string> = {};
    for (const { worker } of targets) captured[worker.id] = await runtime.capture(worker, options);
    return { status: "succeeded", output: { captured } };
  }

  public async stopWorker(trigger: TriggerDefinition, item: WorkItem, outputs: Readonly<Record<string, ActionResult>>, ref: WorkerRef): Promise<ActionResult> {
    const targets = await this.resolve(trigger, item, outputs, ref);
    if (targets.length === 0) return { status: "skipped", message: "No matching worker is running." };
    const stopped: string[] = [];
    for (const { worker, run } of targets) {
      if (!isActiveRun(run.status)) continue;
      const completedAt = this.now().toISOString();
      await this.dependencies.agentLauncher.stop?.(worker, run);
      await this.dependencies.runStore.finishActive(run.identity, run.claimedAt, { status: "stopped", completedAt });
      stopped.push(worker.id);
    }
    return stopped.length === 0 ? { status: "skipped", message: "No matching worker was still active." } : { status: "succeeded", output: { workerIds: stopped } };
  }

  public async recordOutputs(trigger: TriggerDefinition, item: WorkItem, outputs: Readonly<Record<string, ActionResult>>, ref: WorkerRef, values: Record<string, unknown>): Promise<ActionResult> {
    const targets = await this.resolve(trigger, item, outputs, ref);
    if (targets.length === 0) return { status: "skipped", message: "No matching worker is running." };
    for (const { run } of targets) {
      const at = this.now().toISOString();
      const recorded = await this.dependencies.runStore.recordWorkerOutputs?.(run.identity, run.claimedAt, values, at);
      if (recorded === undefined && !this.dependencies.runStore.recordWorkerOutputs) {
        if (!run.worker) continue;
        const previous = run.worker.metadata?.outputs;
        const oldOutputs = previous !== null && typeof previous === "object" && !Array.isArray(previous) ? previous as Record<string, unknown> : {};
        run.worker = { ...run.worker, metadata: { ...run.worker.metadata, outputs: { ...oldOutputs, ...values } } };
        run.updatedAt = at;
        await this.dependencies.runStore.update(run);
      } else if (!recorded) return { status: "skipped", message: `Worker ${run.worker?.id ?? run.id} changed before its outputs could be recorded.` };
    }
    return { status: "succeeded", output: { workerIds: targets.map(({ worker }) => worker.id), outputs: values } };
  }

  public async reconcilePersistedRuns(triggers: readonly TriggerDefinition[]): Promise<void> {
    if (!this.dependencies.runStore.listActive) return;
    const repositories = new Map<string, RepositoryScope>();
    for (const trigger of triggers) repositories.set(`${trigger.repository.id}\u0000${trigger.repository.root}`, trigger.repository);
    for (const repository of repositories.values()) for (const run of await this.dependencies.runStore.listActive(repository)) {
      if (this.locallyObservedRuns.has(runGeneration(run))) continue;
      const source = this.sources.get(run.identity.sourceId);
      if (!source) continue;
      if (!run.worker) { await this.finishObservedRun(source, run, "failed", "Relay restarted before the worker was launched."); continue; }
      try {
        const completion = await this.dependencies.agentLauncher.reconcile?.(run.worker, run);
        if (completion) await this.finishObservedRun(source, run, completion.status, completion.error);
      } catch (error) { await this.finishObservedRun(source, run, "failed", `Worker reconciliation failed: ${messageFor(error)}`); }
    }
  }

  public async stop(options: StopWorkersOptions = {}): Promise<void> {
    this.abort();
    if (options.cleanupActive) await this.stopAndCleanupActiveRuns();
    await Promise.all([...this.nonPersistentObservers]);
  }

  private async activeWorkerForItem(trigger: TriggerDefinition, sourceId: string, itemId: string): Promise<RunRecord | undefined> {
    if (this.dependencies.oneWorkerPerItem === false || !this.dependencies.runStore.findRunsForItem) return undefined;
    const runs = await this.dependencies.runStore.findRunsForItem({ repository: trigger.repository, sourceId, itemId, selection: "active" });
    return runs.find((run) => run.worker !== undefined);
  }

  private async workerTargets(trigger: TriggerDefinition, item: WorkItem, explicitWorkerIds?: readonly string[], selection?: "latest" | "active" | "all"): Promise<readonly RunRecord[]> {
    if (!this.dependencies.runStore.findWorkerTargets) throw new Error("The configured run store cannot resolve worker action targets.");
    const selector = trigger.targets?.workers;
    return this.dependencies.runStore.findWorkerTargets({ repository: trigger.repository, sourceId: item.sourceId, itemId: item.id, selection: selection ?? selector?.runs ?? "all", workerIds: explicitWorkerIds ?? selector?.workerIds });
  }

  private requireRuntime(verb: string): WorkerRuntime {
    const runtime = this.dependencies.agentLauncher.runtime;
    if (!runtime) throw new Error(`The configured execution adapter cannot ${verb}. Set execution.adapter: tmux.`);
    return runtime;
  }

  private async branchOfAction(trigger: TriggerDefinition, item: WorkItem, outputs: Readonly<Record<string, ActionResult>>, actionId: string): Promise<string | undefined> {
    const produced = outputs[actionId];
    if (!produced) throw new Error(`Action '${actionId}' has not run before this one in trigger '${trigger.id}'.`);
    const runId = produced.output?.runId;
    if (typeof runId !== "string") return undefined;
    const runs = await this.workerTargets(trigger, item, undefined, "all");
    return runs.find((run) => run.id === runId)?.workspace?.branch;
  }

  private startObservingWorker(source: WorkSource, run: RunRecord): void {
    const observer = this.observeWorker(source, run).catch((error: unknown) => {
      this.dependencies.logger.error("Task relay worker observation failed unexpectedly", { runId: run.id, itemId: run.item.id, title: run.item.title, error: messageFor(error) });
    });
    if (isPersistentWorker(run)) return;
    this.nonPersistentObservers.add(observer);
    void observer.then(() => this.nonPersistentObservers.delete(observer));
  }

  private async observeWorker(source: WorkSource, run: RunRecord): Promise<void> {
    const generation = runGeneration(run);
    this.locallyObservedRuns.add(generation);
    try {
      const completion = await this.dependencies.agentLauncher.wait?.(run.worker!, run);
      if (completion) await this.finishObservedRun(source, run, completion.status, completion.error);
    } catch (error) { await this.finishObservedRun(source, run, "failed", `Worker observation failed: ${messageFor(error)}`); }
    finally { this.locallyObservedRuns.delete(generation); }
  }

  private async stopAndCleanupActiveRuns(): Promise<void> {
    if (!this.dependencies.runStore.listActive) { this.dependencies.logger.warn("Run store cannot enumerate active runs for cleanup"); return; }
    const repositories = await this.dependencies.listRepositories?.() ?? [];
    for (const repository of repositories) for (const run of await this.dependencies.runStore.listActive(repository)) {
      const source = this.sources.get(run.identity.sourceId);
      try {
        if (run.worker) await this.dependencies.agentLauncher.stop?.(run.worker, run);
        const stopped = await this.dependencies.runStore.finishActive(run.identity, run.claimedAt, { status: "stopped", completedAt: this.now().toISOString() });
        if (run.workspace) await this.dependencies.workspaceProvider.cleanup?.(run.workspace, run);
        if (run.workspace) await this.dependencies.runStore.markWorkspaceCleaned(run.identity, run.claimedAt, this.now().toISOString());
        if (source && stopped) await this.report(source, "stopped", stopped);
      } catch (error) { this.dependencies.logger.error("Could not stop active run", { runId: run.id, itemId: run.item.id, title: run.item.title, error: messageFor(error) }); }
    }
  }

  private async finishObservedRun(source: WorkSource, observed: RunRecord, status: "succeeded" | "failed", error?: string): Promise<void> {
    const current = await this.dependencies.runStore.finishActive(observed.identity, observed.claimedAt, { status, error, completedAt: this.now().toISOString() });
    if (current) await this.report(source, status, current, error);
  }

  private async report(source: WorkSource, type: SourceEvent["type"], run: RunRecord, error?: string): Promise<boolean> {
    try { await source.report({ type, sourceId: source.id, run, occurredAt: this.now().toISOString(), error }); return true; }
    catch (reportError) {
      this.dependencies.logger.warn("Work source event reporting failed", { runId: run.id, itemId: run.item.id, title: run.item.title, type, error: messageFor(reportError) });
      return false;
    }
  }
}

function normaliseConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) throw new Error("Trigger maxConcurrent must be a positive integer");
  return value;
}

function runGeneration(run: Pick<RunRecord, "id" | "claimedAt">): string { return `${run.id}\u0000${run.claimedAt}`; }
function isPersistentWorker(run: RunRecord): boolean { return run.worker?.metadata?.persistent === true; }
function messageFor(error: unknown): string { return error instanceof Error ? error.message : String(error); }
