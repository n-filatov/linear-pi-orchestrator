import PQueue from "p-queue";
import { createHash, randomUUID } from "node:crypto";

import {
  createRunKey,
  createWorkflowRunKey,
  isTerminalWorkItem,
  type AgentLauncher,
  type RelayLogger,
  type RunRecord,
  type RunStore,
  type SourceEvent,
  type TriggerDefinition,
  type WorkItem,
  type WorkerChildHandle,
  type WorkerChildSpec,
  type WorkerInputSpec,
  type WorkerRuntime,
  type WorkflowDefinition,
  type WorkflowJobDefinition,
  type WorkflowJobStatus,
  type WorkflowRunRecord,
  type WorkflowRunStore,
  type WorkSource,
  type WorkspaceProvider,
  isActiveRun,
  isTerminalJobStatus,
  workerChildren,
} from "../domain/index.js";
import { decideJob, jobInstances, jobTimedOut, runOutcome, timedOut, type JobDecision } from "../workflows/reconciler.js";
import Handlebars from "handlebars";
import type { ActionContext, ActionResult, LaunchWorkerActionRequest, RelayPluginRegistry, ResolvedWorker, WorkerRef } from "../plugins/index.js";

export interface TriggerProvider {
  list(): Promise<readonly TriggerDefinition[]>;
}

export interface WorkflowProvider {
  list(): Promise<readonly WorkflowDefinition[]>;
}

export interface TaskRelayDependencies {
  triggers: TriggerProvider;
  /** Workflows are evaluated after triggers, against their own durable runs. */
  workflows?: WorkflowProvider;
  workflowRuns?: WorkflowRunStore;
  sources: Iterable<WorkSource>;
  runStore: RunStore;
  workspaceProvider: WorkspaceProvider;
  agentLauncher: AgentLauncher;
  logger: RelayLogger;
  actionPlugins?: RelayPluginRegistry;
  actionExecutions?: ActionInvocationStore;
  /**
   * Applied to every worker launch, whichever action requested it. The
   * composition root owns the rules because they depend on configuration the
   * engine deliberately does not read.
   */
  validateLaunch?(request: LaunchWorkerActionRequest, context: { triggerId: string; actionId: string }): void;
  /**
   * Refuse a launch when the ticket already has a live worker, whichever
   * trigger or workflow job launched it. Defaults to true.
   */
  oneWorkerPerItem?: boolean;
  now?: () => Date;
}

export interface TickResult {
  triggersVisited: number;
  itemsDiscovered: number;
  runsClaimed: number;
  runsLaunched: number;
  skipped: number;
  actionsExecuted: number;
  actionsFailed: number;
  /** Per-item outcomes retained for human-readable watch output. */
  items: TickItemOutcome[];
}

export interface TickItemOutcome {
  item: Pick<WorkItem, "id" | "title">;
  triggerId: string;
  status: "launched" | "skipped" | "failed" | "action";
  reason?: string;
  workerId?: string;
}

export interface ActionInvocationClaim {
  idempotencyKey: string;
  triggerId: string;
  sourceId: string;
  itemId: string;
  actionId: string;
  claimedAt: string;
}

export interface ActionInvocationStore {
  claimActionExecution(claim: ActionInvocationClaim): Promise<{ claimedAt: string } | undefined>;
  finishActionExecution(id: string, claimedAt: string, transition: { status: "succeeded" | "failed" | "skipped"; completedAt: string; output?: unknown; error?: unknown }): Promise<unknown>;
}

export interface StopOptions {
  /** Also stop currently active workers and ask the workspace provider to clean up. */
  cleanupActive?: boolean;
}

/**
 * Repository-scoped dispatcher. Its only concurrency guarantee is to coalesce
 * overlapping local ticks; RunStore.claim is the cross-process guard.
 */
export class TaskRelay {
  private readonly sources = new Map<string, WorkSource>();
  private readonly now: () => Date;
  /** Generations this relay is already waiting on; do not reconcile them too. */
  private readonly locallyObservedRuns = new Set<string>();
  /** Local workers whose source lifecycle notifications must finish before close. */
  private readonly nonPersistentObservers = new Set<Promise<void>>();
  private activeTick: Promise<TickResult> | undefined;
  private stopController = new AbortController();

  public constructor(private readonly dependencies: TaskRelayDependencies) {
    for (const source of dependencies.sources) {
      if (this.sources.has(source.id)) {
        throw new Error(`Duplicate work source id: ${source.id}`);
      }
      this.sources.set(source.id, source);
    }
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Returns the in-flight result when a caller invokes tick concurrently. */
  public tick(): Promise<TickResult> {
    if (this.activeTick) return this.activeTick;

    this.activeTick = this.tickInternal().finally(() => {
      this.activeTick = undefined;
    });
    return this.activeTick;
  }

  /** Stops future dispatches. Active workers are only stopped when requested. */
  public async stop(options: StopOptions = {}): Promise<void> {
    this.stopController.abort();
    await this.activeTick;

    if (options.cleanupActive) {
      await this.stopAndCleanupActiveRuns();
    }

    // Direct-process observers can still report a terminal result using this
    // source. Tmux workers persist their outcome for later reconciliation and
    // intentionally do not hold `relay once` open.
    await Promise.all([...this.nonPersistentObservers]);

    await Promise.all([...this.sources.values()].map(async (source) => source.close?.()));
  }

  private async tickInternal(): Promise<TickResult> {
    const result: TickResult = {
      triggersVisited: 0,
      itemsDiscovered: 0,
      runsClaimed: 0,
      runsLaunched: 0,
      skipped: 0,
      actionsExecuted: 0,
      actionsFailed: 0,
      items: [],
    };

    const triggers = await this.dependencies.triggers.list();
    await this.reconcilePersistedRuns(triggers);
    for (const trigger of triggers) {
      if (this.stopController.signal.aborted) break;
      if (!trigger.enabled) continue;
      result.triggersVisited += 1;
      await this.runTrigger(trigger, result);
    }
    for (const workflow of await this.dependencies.workflows?.list() ?? []) {
      if (this.stopController.signal.aborted) break;
      if (!workflow.enabled) continue;
      result.triggersVisited += 1;
      await this.runWorkflow(workflow, result);
    }
    return result;
  }

  // ── Workflows ─────────────────────────────────────────────────────────────

  private async runWorkflow(workflow: WorkflowDefinition, result: TickResult): Promise<void> {
    const source = this.sources.get(workflow.sourceId);
    if (!source) {
      this.dependencies.logger.error("Configured workflow has no matching work source", { workflowId: workflow.id, sourceId: workflow.sourceId });
      return;
    }
    const runs = this.dependencies.workflowRuns;
    if (!runs) throw new Error(`Workflow '${workflow.id}' needs a workflow run store, but none is configured.`);

    let items: readonly WorkItem[];
    try {
      items = await source.discover({ trigger: workflowAsTrigger(workflow), signal: this.stopController.signal });
    } catch (error) {
      this.dependencies.logger.error("Work source discovery failed", { workflowId: workflow.id, sourceId: source.id, error: messageFor(error) });
      return;
    }
    result.itemsDiscovered += items.length;

    // A concurrency group is checked and then claimed by opening a run. Those
    // two steps are not atomic, so items must be reconciled one at a time when
    // a group is configured, or two could both pass the check.
    const queue = new PQueue({ concurrency: workflow.concurrency ? 1 : normaliseConcurrency(workflow.maxConcurrent) });
    for (const item of items) {
      void queue.add(async () => this.reconcileWorkflow(workflow, source, item, runs, result)).catch((error: unknown) => {
        this.dependencies.logger.error("Workflow reconciliation failed unexpectedly", {
          workflowId: workflow.id, itemId: item.id, title: item.title, error: messageFor(error),
        });
      });
    }
    await queue.onIdle();
  }

  private async reconcileWorkflow(
    workflow: WorkflowDefinition,
    source: WorkSource,
    item: WorkItem,
    runs: WorkflowRunStore,
    result: TickResult,
  ): Promise<void> {
    const occurrence = await this.workflowOccurrence(workflow, item, runs);
    const identity = { repository: workflow.repository, workflowId: workflow.id, sourceId: item.sourceId, itemId: item.id, occurrence };
    const startedAt = this.now().toISOString();

    // Concurrency is decided before the run is opened, so a group that is
    // already busy never produces a second live run to reconcile.
    const group = workflow.concurrency ? renderGroup(workflow.concurrency.group, item) : undefined;
    if (group) {
      const key = createWorkflowRunKey(identity);
      const live = (await runs.findRunningInGroup(workflow.repository, group)).filter((other) => other.id !== key);
      if (live.length > 0) {
        if (!workflow.concurrency!.cancelInProgress) {
          result.skipped += 1;
          this.recordItemOutcome(result, workflowAsTrigger(workflow), item, "skipped",
            `Concurrency group '${group}' is held by ${live.map((other) => other.item.id).join(", ")}.`);
          return;
        }
        for (const other of live) await this.cancelWorkflowRun(workflow, other, runs, result);
      }
    }

    let run = await runs.openWorkflowRun({
      identity,
      item,
      startedAt,
      ...(workflow.timeoutMs ? { timeoutAt: new Date(this.now().getTime() + workflow.timeoutMs).toISOString() } : {}),
      ...(group ? { concurrencyGroup: group } : {}),
    });
    if (run.status !== "running") {
      // Say so rather than returning silently: an item that keeps matching but
      // never advances is otherwise indistinguishable from a broken workflow.
      result.skipped += 1;
      this.recordItemOutcome(result, workflowAsTrigger(workflow), item, "skipped", `Workflow run ${occurrence} already ${run.status}.`);
      return;
    }

    // A worker launched on an earlier tick may have finished since. Job state is
    // derived from the run record, never assumed from the last decision.
    run = await this.refreshWorkflowJobs(workflow, run, runs) ?? run;

    if (timedOut(run, this.now())) {
      await this.expireWorkflow(workflow, run, runs, result, item);
      return;
    }

    const instances = jobInstances(workflow.jobs);
    const known = new Set(instances.keys());
    const outputs: Record<string, ActionResult> = actionOutputsOf(run);
    for (const job of workflow.jobs) {
      if (this.stopController.signal.aborted) break;
      // A job with its own deadline fails alone, leaving the run to continue.
      if (jobTimedOut(job, run.jobs[job.id], this.now())) {
        run = await runs.updateWorkflowJob(identity, job.id, { status: "failed", error: "Job timed out.", at: this.now().toISOString() }) ?? run;
        result.actionsFailed += 1;
        this.recordItemOutcome(result, workflowAsTrigger(workflow), item, "failed", `${job.id}: timed out.`);
        continue;
      }
      let decision: JobDecision;
      try {
        decision = decideJob({ job, states: run.jobs, item, known, instances });
      } catch (error) {
        // A bad `if:` must not silently hold a workflow open for ever.
        decision = { action: "settle", status: "omitted", reason: messageFor(error) };
      }
      if (decision.action === "hold") continue;
      if (decision.action === "settle") {
        run = await runs.updateWorkflowJob(identity, job.id, { status: decision.status, message: decision.reason, at: this.now().toISOString() }) ?? run;
        result.skipped += 1;
        this.recordItemOutcome(result, workflowAsTrigger(workflow), item, "skipped", `${job.id}: ${decision.reason}`);
        continue;
      }
      run = await this.executeWorkflowJob(workflow, source, item, job, identity, runs, outputs, result) ?? run;
    }

    const outcome = runOutcome(workflow.jobs, run.jobs);
    if (outcome.done) await runs.finishWorkflowRun(identity, outcome.status, this.now().toISOString());
  }

  /** Maps each job's launched run onto a job status, so `needs` sees the truth. */
  private async refreshWorkflowJobs(
    workflow: WorkflowDefinition,
    run: WorkflowRunRecord,
    runs: WorkflowRunStore,
  ): Promise<WorkflowRunRecord | undefined> {
    let current: WorkflowRunRecord | undefined = run;
    for (const job of workflow.jobs) {
      const state = run.jobs[job.id];
      if (!state?.runId || state.status !== "started") continue;
      const record = (await this.dependencies.runStore.findWorkerTargets?.({
        repository: workflow.repository,
        sourceId: run.identity.sourceId,
        itemId: run.identity.itemId,
        selection: "all",
        includeCleaned: true,
      }) ?? []).find((candidate) => candidate.id === state.runId);
      if (!record || isActiveRun(record.status)) continue;
      const status: WorkflowJobStatus = record.status === "succeeded" || record.status === "stopped" ? "succeeded" : "failed";
      current = await runs.updateWorkflowJob(run.identity, job.id, {
        status,
        outputs: signalOutputs(record),
        ...(record.error ? { error: record.error } : {}),
        at: this.now().toISOString(),
      }) ?? current;
      if (current) run = current;
    }
    return current;
  }

  private async executeWorkflowJob(
    workflow: WorkflowDefinition,
    source: WorkSource,
    item: WorkItem,
    job: WorkflowJobDefinition,
    identity: WorkflowRunRecord["identity"],
    runs: WorkflowRunStore,
    outputs: Record<string, ActionResult>,
    result: TickResult,
  ): Promise<WorkflowRunRecord | undefined> {
    const registry = this.dependencies.actionPlugins;
    if (!registry) throw new Error(`Workflow ${workflow.id} declares jobs, but no action registry is configured.`);
    const plugin = registry.action(job.use);
    if (!plugin) throw new Error(`Unknown action plugin '${job.use}' in workflow ${workflow.id}.`);
    const config = registry.parseActionConfig(job.use, job.config ?? {});
    const trigger = workflowAsTrigger(workflow, job.id);
    const executionId = JSON.stringify([identity.repository.id, identity.repository.root, workflow.id, identity.itemId, identity.occurrence, job.id]);

    this.dependencies.logger.info("Workflow job started", { workflowId: workflow.id, jobId: job.id, actionType: job.use, itemId: item.id, title: item.title });
    try {
      // Workflow jobs share the action plugin contract with trigger actions.
      // In particular, worker-targeted plugins (such as `cleanup`) must run
      // once for every selected run. Previously we merely exposed `targets` in
      // the context, leaving `context.worker` undefined and making cleanup a
      // permanent no-op.
      const targetRuns = plugin.target === "worker" ? await this.workerTargets(trigger, item) : [undefined];
      if (plugin.target === "worker" && targetRuns.length === 0) {
        const actionResult: ActionResult = { status: "skipped", message: "No matching workers." };
        outputs[job.id] = actionResult;
        result.skipped += 1;
        this.recordItemOutcome(result, trigger, item, "skipped", `${job.id}: ${actionResult.message}`);
        // Cleanup is terminal-workflow housekeeping. If its ticket has no
        // worker, there is nothing left to wait for; keeping the job pending
        // makes every terminal item retry and contend on the shared state lock.
        const status: WorkflowJobStatus = job.use === "cleanup" ? "skipped" : "pending";
        return runs.updateWorkflowJob(identity, job.id, { status, message: actionResult.message, at: this.now().toISOString(), attempted: true });
      }

      const actionResults: ActionResult[] = [];
      for (const targetRun of targetRuns) {
        const context: ActionContext = {
          executionId,
          actionId: job.id,
          triggerId: workflow.id,
          repository: workflow.repository,
          sourceId: source.id,
          item,
          outputs,
          targets: workflow.targets?.workers,
          worker: targetRun?.worker,
          run: targetRun,
          workers: {
            launch: (request) => this.launchFromAction(source, trigger, item, job.id, request, result, outputs),
            cleanup: (workerId) => this.cleanupFromAction(source, trigger, item, workerId),
            resolve: (ref) => this.resolveWorkers(trigger, item, outputs, ref),
            exec: (ref, spec) => this.execInWorker(trigger, item, outputs, ref, spec),
            send: (ref, spec) => this.sendToWorker(trigger, item, outputs, ref, spec),
            capture: (ref, options) => this.captureWorker(trigger, item, outputs, ref, options),
            stop: (ref) => this.stopWorker(trigger, item, outputs, ref),
          },
          signal: this.stopController.signal,
        };
        const actionResult = await plugin.execute(context, config);
        actionResults.push(actionResult);
        if (actionResult.status !== "skipped" && job.use !== "launch") {
          this.recordItemOutcome(result, trigger, item, "action", `${job.id}: succeeded.`, targetRun?.worker?.id);
        }
      }
      const actionResult = actionResults.find((candidate) => candidate.status === "succeeded") ?? actionResults[0]!;
      outputs[job.id] = actionResult;
      result.actionsExecuted += 1;

      // A plugin that reports `skipped` has nothing to do *yet* — no worker has
      // appeared, for instance — so the job stays pending and is retried on a
      // later tick. Only `if:` and an unsatisfiable dependency settle a job as
      // skipped or omitted.
      if (actionResult.status === "skipped") {
        result.skipped += 1;
        this.recordItemOutcome(result, trigger, item, "skipped", `${job.id}: ${actionResult.message ?? "Nothing to do yet."}`);
        return runs.updateWorkflowJob(identity, job.id, { status: "pending", message: actionResult.message, at: this.now().toISOString(), attempted: true });
      }

      const runId = stringOutput(actionResult, "runId");
      const workerId = stringOutput(actionResult, "workerId");
      // A job that launched a live worker is `started`, not `succeeded`: the
      // agent is still running, and a later job may depend on either fact.
      // `cleanup` returns the cleaned run ID for auditability, not because this
      // workflow job launched a new worker. Only item-targeted actions can put
      // a workflow job into the live `started` state.
      const status: WorkflowJobStatus = plugin.target === "worker" ? "succeeded" : runId ? "started" : "succeeded";
      if (job.use !== "launch") this.recordItemOutcome(result, trigger, item, "action", `${job.id}: ${status}.`, workerId);
      return runs.updateWorkflowJob(identity, job.id, {
        status,
        runId,
        workerId,
        outputs: jsonOutputs(actionResult),
        at: this.now().toISOString(),
        attempted: true,
      });
    } catch (error) {
      result.actionsFailed += 1;
      this.dependencies.logger.error("Workflow job failed", { workflowId: workflow.id, jobId: job.id, itemId: item.id, title: item.title, error: messageFor(error) });
      this.recordItemOutcome(result, trigger, item, "failed", `${job.id}: ${messageFor(error)}`);
      return runs.updateWorkflowJob(identity, job.id, { status: "failed", error: messageFor(error), at: this.now().toISOString(), attempted: true });
    }
  }

  /**
   * Stops an older run so a newer one in the same concurrency group can start.
   * Its live workers are stopped first: leaving them running would defeat the
   * point of cancelling, and orphan windows nothing will ever close.
   */
  private async cancelWorkflowRun(
    workflow: WorkflowDefinition,
    run: WorkflowRunRecord,
    runs: WorkflowRunStore,
    result: TickResult,
  ): Promise<void> {
    const at = this.now().toISOString();
    for (const job of workflow.jobs) {
      const state = run.jobs[job.id];
      if (!state || isTerminalJobStatus(state.status)) continue;
      if (state.status === "started" && state.workerId) {
        await this.stopWorker(workflowAsTrigger(workflow), run.item, {}, { workerId: state.workerId }).catch((error: unknown) => {
          this.dependencies.logger.warn("Could not stop a worker while cancelling a superseded run", {
            workflowId: workflow.id, itemId: run.identity.itemId, workerId: state.workerId, error: messageFor(error),
          });
        });
      }
      await runs.updateWorkflowJob(run.identity, job.id, { status: "omitted", message: "Superseded by a newer run in the same concurrency group.", at });
    }
    await runs.finishWorkflowRun(run.identity, "failed", at);
    result.skipped += 1;
    this.recordItemOutcome(result, workflowAsTrigger(workflow), run.item, "skipped", `Cancelled: superseded in concurrency group '${run.concurrencyGroup}'.`);
    this.dependencies.logger.info("Workflow run cancelled by a newer run", {
      workflowId: workflow.id, itemId: run.identity.itemId, group: run.concurrencyGroup,
    });
  }

  private async expireWorkflow(
    workflow: WorkflowDefinition,
    run: WorkflowRunRecord,
    runs: WorkflowRunStore,
    result: TickResult,
    item: WorkItem,
  ): Promise<void> {
    const at = this.now().toISOString();
    for (const job of workflow.jobs) {
      const status = run.jobs[job.id]?.status ?? "pending";
      if (isTerminalJobStatus(status)) continue;
      await runs.updateWorkflowJob(run.identity, job.id, { status: "omitted", message: "Workflow run timed out.", at });
    }
    await runs.finishWorkflowRun(run.identity, "failed", at);
    result.skipped += 1;
    this.recordItemOutcome(result, workflowAsTrigger(workflow), item, "failed", "Workflow run timed out.");
    this.dependencies.logger.warn("Workflow run timed out", { workflowId: workflow.id, itemId: run.identity.itemId, startedAt: run.startedAt });
  }

  /**
   * Which occurrence of a workflow this item belongs to. `once-per-item` never
   * reruns; `on-change` opens a new occurrence when the item changes; and
   * `every-poll` opens a new one only after the previous occurrence finished, so
   * a reopened ticket runs again without a poll ever duplicating live work.
   */
  private async workflowOccurrence(
    workflow: WorkflowDefinition,
    item: WorkItem,
    runs: WorkflowRunStore,
  ): Promise<string> {
    const base = { repository: workflow.repository, workflowId: workflow.id, sourceId: item.sourceId, itemId: item.id };
    const policy = workflow.firePolicy ?? "once-per-match";
    if (policy === "on-change") return `change-${actionFingerprint({ selector: workflow.selector } as TriggerDefinition, item)}`;
    if (policy !== "every-poll") return "item";
    const latest = await runs.latestWorkflowRun(base);
    if (!latest) return "run-1";
    if (latest.status === "running") return latest.identity.occurrence;
    const previous = Number(/^run-(\d+)$/.exec(latest.identity.occurrence)?.[1] ?? "0");
    return `run-${previous + 1}`;
  }

  private async runTrigger(trigger: TriggerDefinition, result: TickResult): Promise<void> {
    const source = this.sources.get(trigger.sourceId);
    if (!source) {
      this.dependencies.logger.error("Configured trigger has no matching work source", {
        triggerId: trigger.id,
        sourceId: trigger.sourceId,
      });
      return;
    }

    let items: readonly WorkItem[];
    try {
      items = await source.discover({ trigger, signal: this.stopController.signal });
    } catch (error) {
      this.dependencies.logger.error("Work source discovery failed", {
        triggerId: trigger.id,
        sourceId: source.id,
        error: messageFor(error),
      });
      return;
    }

    result.itemsDiscovered += items.length;
    const maxConcurrent = normaliseConcurrency(trigger.maxConcurrent);
    const eligible: WorkItem[] = [];
    for (const item of items) {
      if (isTerminalWorkItem(item) && !trigger.actions?.length) {
        result.skipped += 1;
        this.recordItemOutcome(result, trigger, item, "skipped", "Ticket is terminal.");
        continue;
      }
      if (item.sourceId !== source.id) {
        this.dependencies.logger.warn("Source returned an item with a mismatched source id", {
          expectedSourceId: source.id,
          itemSourceId: item.sourceId,
          itemId: item.id,
          title: item.title,
        });
        result.skipped += 1;
        this.recordItemOutcome(result, trigger, item, "skipped", `Source '${item.sourceId}' does not match '${source.id}'.`);
        continue;
      }
      if (!trigger.actions?.length) {
        const alreadyActive = await this.dependencies.runStore.findActive({
          repository: trigger.repository,
          sourceId: source.id,
          itemId: item.id,
          triggerId: trigger.id,
        });
        if (alreadyActive) {
          result.skipped += 1;
          this.recordItemOutcome(result, trigger, item, "skipped", `Worker ${alreadyActive.worker?.id ?? "run"} is already active.`);
          continue;
        }
      }
      eligible.push(item);
    }

    // The store, not this preliminary queue, owns the cross-process capacity
    // decision. A full-size local queue keeps a relay from over-provisioning.
    const queue = new PQueue({ concurrency: maxConcurrent });
    for (const item of eligible) {
      void queue.add(async () => {
        if (trigger.actions?.length) await this.executeActions(source, trigger, item, result);
        else {
          const outcome = await this.dispatchItem(source, trigger, item);
          result.runsClaimed += outcome.claimed ? 1 : 0;
          result.runsLaunched += outcome.launched ? 1 : 0;
          result.skipped += outcome.skipped ? 1 : 0;
          this.recordItemOutcome(result, trigger, item, outcome.launched ? "launched" : outcome.failed ? "failed" : "skipped", outcome.reason, outcome.run?.worker?.id);
        }
      }).catch((error: unknown) => {
        this.dependencies.logger.error("Task relay dispatch failed unexpectedly", {
          triggerId: trigger.id,
          sourceId: source.id,
          itemId: item.id,
          title: item.title,
          error: messageFor(error),
        });
      });
    }
    await queue.onIdle();
  }

  /**
   * The live worker for a ticket, if any, across every trigger and workflow job
   * in this repository. A run whose worker has since exited is reconciled by
   * `reconcilePersistedRuns`, so a stale record cannot block a ticket forever.
   */
  private async activeWorkerForItem(trigger: TriggerDefinition, sourceId: string, itemId: string): Promise<RunRecord | undefined> {
    if (this.dependencies.oneWorkerPerItem === false) return undefined;
    const findRunsForItem = this.dependencies.runStore.findRunsForItem;
    if (!findRunsForItem) return undefined;
    const runs = await findRunsForItem.call(this.dependencies.runStore, {
      repository: trigger.repository,
      sourceId,
      itemId,
      selection: "active",
    });
    return runs.find((run) => run.worker !== undefined);
  }

  private async dispatchItem(
    source: WorkSource,
    trigger: TriggerDefinition,
    item: WorkItem,
  ): Promise<{ claimed: boolean; launched: boolean; skipped: boolean; failed?: boolean; reason?: string; run?: RunRecord }> {
    if (this.stopController.signal.aborted || isTerminalWorkItem(item)) {
      return { claimed: false, launched: false, skipped: true, reason: this.stopController.signal.aborted ? "Relay is stopping." : "Ticket is terminal." };
    }
    if (item.sourceId !== source.id) {
      this.dependencies.logger.warn("Source returned an item with a mismatched source id", {
        expectedSourceId: source.id,
        itemSourceId: item.sourceId,
        itemId: item.id,
        title: item.title,
      });
      return { claimed: false, launched: false, skipped: true, reason: `Source '${item.sourceId}' does not match '${source.id}'.` };
    }

    const identity = {
      repository: trigger.repository,
      sourceId: source.id,
      itemId: item.id,
      triggerId: trigger.id,
    };
    const activeRun = await this.dependencies.runStore.findActive(identity);
    if (activeRun) {
      return { claimed: false, launched: false, skipped: true, reason: `Worker ${activeRun.worker?.id ?? "run"} is already active.` };
    }

    // `findActive` keys on the trigger id, and both a trigger action and a
    // workflow job compose their own id into it. Two of them aimed at one
    // ticket therefore hold different keys, and neither sees the other's live
    // worker. This guard is the one that keeps a ticket to a single worktree,
    // tmux window, and branch.
    const sibling = await this.activeWorkerForItem(trigger, source.id, item.id);
    if (sibling) {
      return { claimed: false, launched: false, skipped: true, reason: `Worker ${sibling.worker?.id ?? sibling.id} is already active for ${item.id}.` };
    }

    let agent;
    try {
      agent = await this.dependencies.agentLauncher.resolve(trigger.agent, item, trigger);
    } catch (error) {
      this.dependencies.logger.error("Agent resolution failed", {
        triggerId: trigger.id,
        itemId: item.id,
        title: item.title,
        error: messageFor(error),
      });
      return { claimed: false, launched: false, skipped: true, reason: `Agent resolution failed: ${messageFor(error)}` };
    }

    const claimedAt = this.now().toISOString();
    const run = await this.dependencies.runStore.claim({
      id: createRunKey(identity),
      identity,
      item,
      trigger,
      agent,
      claimedAt,
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

      run.workspace = await this.dependencies.workspaceProvider.provision(run, this.stopController.signal);
      run.status = "launching";
      run.updatedAt = this.now().toISOString();
      await this.dependencies.runStore.update(run);

      run.worker = await this.dependencies.agentLauncher.launch({
        run,
        item,
        trigger,
        workspace: run.workspace,
        agent: run.agent,
        signal: this.stopController.signal,
      });
      run.status = "running";
      run.updatedAt = this.now().toISOString();
      await this.dependencies.runStore.update(run);
      await this.report(source, "launched", run);
      this.startObservingWorker(source, run);
      this.dependencies.logger.info("Task relay launched work", {
        runId: run.id,
        triggerId: trigger.id,
        sourceId: source.id,
        itemId: item.id,
        title: item.title,
        agentId: run.agent.agentId,
        model: run.agent.model,
      });
      return { claimed: true, launched: true, skipped: false, run };
    } catch (error) {
      run.status = "failed";
      run.error = messageFor(error);
      run.completedAt = this.now().toISOString();
      run.updatedAt = run.completedAt;
      await this.dependencies.runStore.update(run);
      await this.report(source, "failed", run, run.error);
      this.dependencies.logger.error("Task relay failed to launch work", {
        runId: run.id,
        itemId: item.id,
        title: item.title,
        error: run.error,
      });
      return { claimed: true, launched: false, skipped: false, failed: true, reason: run.error, run };
    }
  }

  private async executeActions(source: WorkSource, trigger: TriggerDefinition, item: WorkItem, result: TickResult): Promise<void> {
    const registry = this.dependencies.actionPlugins;
    if (!registry) throw new Error(`Trigger ${trigger.id} declares actions, but no action registry is configured.`);
    const outputs: Record<string, ActionResult> = {};
    let haltPipeline = false;
    for (const action of trigger.actions ?? []) {
      if (this.stopController.signal.aborted || haltPipeline) break;
      const plugin = registry.action(action.use);
      if (!plugin) throw new Error(`Unknown action plugin '${action.use}' in trigger ${trigger.id}.`);
      const config = registry.parseActionConfig(action.use, action.config ?? {});
      const runs = plugin.target === "worker" ? await this.workerTargets(trigger, item) : [undefined];
      if (plugin.target === "worker" && runs.length === 0) {
        outputs[action.id] = { status: "skipped", message: "No matching workers." };
        result.skipped += 1;
        this.recordItemOutcome(result, trigger, item, "skipped", `${action.id}: No matching workers.`);
        continue;
      }
      for (const run of runs) {
        const executionId = actionExecutionId(trigger, item, action.id, run?.worker?.id, run?.claimedAt);
        const actionClaimedAt = await this.claimActionExecution(executionId, trigger, item, action.id);
        if (!actionClaimedAt) {
          this.dependencies.logger.debug("Trigger action deduplicated", { triggerId: trigger.id, actionId: action.id, itemId: item.id, title: item.title, workerId: run?.worker?.id });
          result.skipped += 1;
          this.recordItemOutcome(result, trigger, item, "skipped", `${action.id}: action was already completed or is running.`, run?.worker?.id);
          continue;
        }
        try {
          this.dependencies.logger.info("Trigger action started", { executionId, triggerId: trigger.id, actionId: action.id, actionType: action.use, itemId: item.id, title: item.title, workerId: run?.worker?.id });
          const context: ActionContext = {
            executionId,
            actionId: action.id,
            triggerId: trigger.id,
            repository: trigger.repository,
            sourceId: source.id,
            item,
            outputs,
            targets: trigger.targets?.workers,
            worker: run?.worker,
            run,
            workers: {
              launch: (request) => this.launchFromAction(source, trigger, item, action.id, request, result, outputs),
              cleanup: (workerId) => this.cleanupFromAction(source, trigger, item, workerId),
              resolve: (ref) => this.resolveWorkers(trigger, item, outputs, ref),
              exec: (ref, spec) => this.execInWorker(trigger, item, outputs, ref, spec),
              send: (ref, spec) => this.sendToWorker(trigger, item, outputs, ref, spec),
              capture: (ref, options) => this.captureWorker(trigger, item, outputs, ref, options),
              stop: (ref) => this.stopWorker(trigger, item, outputs, ref),
            },
            signal: this.stopController.signal,
          };
          const actionResult = await plugin.execute(context, config);
          outputs[action.id] = actionResult;
          result.actionsExecuted += 1;
          await this.finishActionExecution(executionId, actionClaimedAt, actionResult.status, actionResult.output);
          this.dependencies.logger.info(`Trigger action ${actionResult.status}`, { executionId, triggerId: trigger.id, actionId: action.id, actionType: action.use, itemId: item.id, title: item.title, workerId: run?.worker?.id });
          if (actionResult.status === "skipped") {
            result.skipped += 1;
            if (action.use !== "launch") this.recordItemOutcome(result, trigger, item, "skipped", `${action.id}: ${actionResult.message ?? "Action skipped."}`, run?.worker?.id);
          } else if (action.use !== "launch") {
            this.recordItemOutcome(result, trigger, item, "action", `${action.id}: completed.`, run?.worker?.id);
          }
        } catch (error) {
          result.actionsFailed += 1;
          await this.finishActionExecution(executionId, actionClaimedAt, "failed", undefined, messageFor(error));
          this.dependencies.logger.error("Trigger action failed", { triggerId: trigger.id, actionId: action.id, itemId: item.id, title: item.title, error: messageFor(error) });
          this.recordItemOutcome(result, trigger, item, "failed", `${action.id}: ${messageFor(error)}`, run?.worker?.id);
          if (!action.continueOnError) {
            haltPipeline = true;
            break;
          }
        }
      }
    }
  }

  private async launchFromAction(source: WorkSource, trigger: TriggerDefinition, item: WorkItem, actionId: string, request: LaunchWorkerActionRequest, result: TickResult, outputs: Readonly<Record<string, ActionResult>> = {}): Promise<ActionResult> {
    this.dependencies.validateLaunch?.(request, { triggerId: trigger.id, actionId });
    const workspace = { ...request.workspace };
    // `fromAction` pins this worker to the branch an earlier action's worker is
    // already on. Without it the two only share a worktree by coincidence,
    // because both branch templates happen to render the same name.
    const fromAction = typeof workspace.fromAction === "string" ? workspace.fromAction : undefined;
    if (fromAction) {
      delete workspace.fromAction;
      const branch = await this.branchOfAction(trigger, item, outputs, fromAction);
      if (!branch) return { status: "skipped", message: `Action '${fromAction}' has no workspace to reuse.` };
      workspace.branchTemplate = branch;
    }
    const derived: TriggerDefinition = {
      ...trigger,
      id: `${trigger.id}:${actionId}`,
      actions: undefined,
      agent: { id: request.harness, model: request.model, promptTemplate: request.prompt, metadata: { modelProfile: request.modelProfile } },
      promptDelivery: request.mode === "interactive" ? "interactive" : undefined,
      metadata: { ...trigger.metadata, ...workspace },
    };
    const outcome = await this.dispatchItem(source, derived, item);
    result.runsClaimed += outcome.claimed ? 1 : 0;
    result.runsLaunched += outcome.launched ? 1 : 0;
    this.recordItemOutcome(result, derived, item, outcome.launched ? "launched" : outcome.failed ? "failed" : "skipped", outcome.reason, outcome.run?.worker?.id);
    if (!outcome.launched) return { status: "skipped", message: outcome.reason ?? outcome.run?.error ?? "Worker was not launched." };
    return { status: "succeeded", output: { runId: outcome.run?.id, workerId: outcome.run?.worker?.id } };
  }

  private async cleanupFromAction(source: WorkSource, trigger: TriggerDefinition, item: WorkItem, workerId: string): Promise<ActionResult> {
    const runs = await this.workerTargets(trigger, item, [workerId]);
    const run = runs[0];
    if (!run) return { status: "skipped", message: `Worker ${workerId} was not found or was already cleaned.` };
    const wasActive = isActiveRun(run.status);
    const completedAt = this.now().toISOString();
    // Mark stopped before killing the window so the concurrent wait() observer
    // loses the finishActive race and emits nothing instead of run.failed.
    const stopped = wasActive ? await this.dependencies.runStore.finishActive(run.identity, run.claimedAt, { status: "stopped", completedAt }) : undefined;
    if (run.worker && (wasActive || run.worker.metadata?.interactive === true)) {
      await this.dependencies.agentLauncher.stop?.(run.worker, run);
    }
    // A trigger/workflow migration can leave two worker records for the same
    // workspace. Stop every worker, but remove that shared worktree only once;
    // the later record still needs its cleanup marker persisted.
    const alreadyCleaned = run.workspace && this.dependencies.runStore.findRunsForItem
      ? (await this.dependencies.runStore.findRunsForItem({
        repository: trigger.repository,
        sourceId: item.sourceId,
        itemId: item.id,
        selection: "all",
        includeCleaned: true,
      })).some((candidate) => candidate.id !== run.id
        && candidate.workspace?.path === run.workspace?.path
        && Boolean(candidate.workspaceCleanedAt))
      : false;
    if (run.workspace && !alreadyCleaned) await this.dependencies.workspaceProvider.cleanup?.(run.workspace, run);
    const cleaned = await this.dependencies.runStore.markWorkspaceCleaned(run.identity, run.claimedAt, completedAt);
    if (!cleaned) throw new Error(`Workspace was removed, but worker ${workerId} changed before cleanup was recorded.`);
    if (stopped) await this.report(source, "stopped", stopped);
    return { status: "succeeded", output: { workerId, runId: run.id, workspace: run.workspace?.path } };
  }

  // ── Worker-scoped verbs available to every action ────────────────────────

  /**
   * Turns a reference into concrete workers. A reference to an earlier action
   * reads that action's recorded output, so a pipeline never has to know worker
   * ids, and a stale or skipped step resolves to nothing rather than guessing.
   */
  private async resolveWorkers(
    trigger: TriggerDefinition,
    item: WorkItem,
    outputs: Readonly<Record<string, ActionResult>>,
    ref: WorkerRef,
  ): Promise<readonly ResolvedWorker[]> {
    let workerIds: readonly string[] | undefined;
    let selection: "latest" | "active" | "all" = "all";

    if ("action" in ref) {
      const produced = outputs[ref.action];
      if (!produced) throw new Error(`Action '${ref.action}' has not run before this one in trigger '${trigger.id}'.`);
      const workerId = produced.output?.workerId;
      if (typeof workerId !== "string") return [];
      workerIds = [workerId];
    } else if ("workerId" in ref) {
      workerIds = [ref.workerId];
    } else {
      selection = ref.runs ?? "latest";
    }

    const runs = await this.workerTargets(trigger, item, workerIds, selection);
    return runs
      .filter((run): run is RunRecord & { worker: NonNullable<RunRecord["worker"]> } => Boolean(run.worker))
      .map((run) => ({ worker: run.worker, run }));
  }

  /** The branch an earlier action's worker is on, if it created one. */
  private async branchOfAction(
    trigger: TriggerDefinition,
    item: WorkItem,
    outputs: Readonly<Record<string, ActionResult>>,
    actionId: string,
  ): Promise<string | undefined> {
    const produced = outputs[actionId];
    if (!produced) throw new Error(`Action '${actionId}' has not run before this one in trigger '${trigger.id}'.`);
    const runId = produced.output?.runId;
    if (typeof runId !== "string") return undefined;
    const runs = await this.workerTargets(trigger, item, undefined, "all");
    return runs.find((run) => run.id === runId)?.workspace?.branch;
  }

  private requireRuntime(verb: string): WorkerRuntime {
    const runtime = this.dependencies.agentLauncher.runtime;
    if (!runtime) throw new Error(`The configured execution adapter cannot ${verb}. Set execution.adapter: tmux.`);
    return runtime;
  }

  private async execInWorker(
    trigger: TriggerDefinition,
    item: WorkItem,
    outputs: Readonly<Record<string, ActionResult>>,
    ref: WorkerRef,
    spec: WorkerChildSpec,
  ): Promise<ActionResult> {
    const runtime = this.requireRuntime(`open a ${spec.open} beside a worker`);
    const targets = await this.resolveWorkers(trigger, item, outputs, ref);
    if (targets.length === 0) return { status: "skipped", message: "No matching worker is running." };

    const opened: WorkerChildHandle[] = [];
    for (const { worker, run } of targets) {
      const child = await runtime.open(worker, spec);
      opened.push(child);
      // Record immediately: a child that is not recorded is a window nothing
      // will ever close. The append is generation-checked and lock-scoped, so a
      // worker that finished while its pane opened keeps its terminal status.
      const recorded = await this.dependencies.runStore.recordWorkerChild?.(run.identity, run.claimedAt, child, this.now().toISOString());
      if (recorded === undefined && !this.dependencies.runStore.recordWorkerChild) {
        run.worker = { ...worker, metadata: { ...worker.metadata, children: [...workerChildren(worker), child] } };
        run.updatedAt = this.now().toISOString();
        await this.dependencies.runStore.update(run);
      } else if (!recorded) {
        this.dependencies.logger.warn("Opened a worker child, but the run changed before it could be recorded", {
          triggerId: trigger.id, itemId: item.id, workerId: worker.id, child: child.target,
        });
      }
    }
    return { status: "succeeded", output: { children: opened, target: spec.open } };
  }

  private async sendToWorker(
    trigger: TriggerDefinition,
    item: WorkItem,
    outputs: Readonly<Record<string, ActionResult>>,
    ref: WorkerRef,
    spec: WorkerInputSpec,
  ): Promise<ActionResult> {
    const runtime = this.requireRuntime("send input to a worker");
    const targets = await this.resolveWorkers(trigger, item, outputs, ref);
    if (targets.length === 0) return { status: "skipped", message: "No matching worker is running." };
    for (const { worker } of targets) await runtime.sendInput(worker, spec);
    return { status: "succeeded", output: { workerIds: targets.map((target) => target.worker.id), submitted: spec.submit !== false } };
  }

  private async captureWorker(
    trigger: TriggerDefinition,
    item: WorkItem,
    outputs: Readonly<Record<string, ActionResult>>,
    ref: WorkerRef,
    options?: { child?: string; lines?: number },
  ): Promise<ActionResult> {
    const runtime = this.requireRuntime("read a worker's output");
    const targets = await this.resolveWorkers(trigger, item, outputs, ref);
    if (targets.length === 0) return { status: "skipped", message: "No matching worker is running." };
    const captured: Record<string, string> = {};
    for (const { worker } of targets) captured[worker.id] = await runtime.capture(worker, options);
    return { status: "succeeded", output: { captured } };
  }

  private async stopWorker(
    trigger: TriggerDefinition,
    item: WorkItem,
    outputs: Readonly<Record<string, ActionResult>>,
    ref: WorkerRef,
  ): Promise<ActionResult> {
    const targets = await this.resolveWorkers(trigger, item, outputs, ref);
    if (targets.length === 0) return { status: "skipped", message: "No matching worker is running." };
    const stopped: string[] = [];
    for (const { worker, run } of targets) {
      if (!isActiveRun(run.status)) continue;
      const completedAt = this.now().toISOString();
      // Record the terminal transition before killing the window, so a
      // concurrent wait() observer loses the race and reports nothing.
      await this.dependencies.runStore.finishActive(run.identity, run.claimedAt, { status: "stopped", completedAt });
      await this.dependencies.agentLauncher.stop?.(worker, run);
      stopped.push(worker.id);
    }
    return stopped.length === 0
      ? { status: "skipped", message: "No matching worker was still active." }
      : { status: "succeeded", output: { workerIds: stopped } };
  }

  private async workerTargets(trigger: TriggerDefinition, item: WorkItem, explicitWorkerIds?: readonly string[], selection?: "latest" | "active" | "all"): Promise<readonly RunRecord[]> {
    if (!this.dependencies.runStore.findWorkerTargets) throw new Error("The configured run store cannot resolve worker action targets.");
    const selector = trigger.targets?.workers;
    return this.dependencies.runStore.findWorkerTargets({
      repository: trigger.repository,
      sourceId: item.sourceId,
      itemId: item.id,
      selection: selection ?? selector?.runs ?? "all",
      workerIds: explicitWorkerIds ?? selector?.workerIds,
    });
  }

  private async claimActionExecution(id: string, trigger: TriggerDefinition, item: WorkItem, actionId: string): Promise<string | undefined> {
    const claimedAt = this.now().toISOString();
    if (!this.dependencies.actionExecutions) return claimedAt;
    const claimed = await this.dependencies.actionExecutions.claimActionExecution({ idempotencyKey: id, triggerId: trigger.id, sourceId: item.sourceId, itemId: item.id, actionId, claimedAt });
    return claimed?.claimedAt;
  }

  private async finishActionExecution(id: string, claimedAt: string, status: "succeeded" | "failed" | "skipped", output?: Record<string, unknown>, error?: string): Promise<void> {
    await this.dependencies.actionExecutions?.finishActionExecution(id, claimedAt, { status, output, error, completedAt: this.now().toISOString() });
  }

  private recordItemOutcome(result: TickResult, trigger: TriggerDefinition, item: WorkItem, status: TickItemOutcome["status"], reason?: string, workerId?: string): void {
    result.items.push({ item: { id: item.id, title: item.title }, triggerId: trigger.id, status, reason, workerId });
  }

  private async stopAndCleanupActiveRuns(): Promise<void> {
    if (!this.dependencies.runStore.listActive) {
      this.dependencies.logger.warn("Run store cannot enumerate active runs for cleanup");
      return;
    }

    const repositoryIds = new Map<string, TriggerDefinition["repository"]>();
    for (const trigger of await this.dependencies.triggers.list()) {
      repositoryIds.set(trigger.repository.id, trigger.repository);
    }
    for (const repository of repositoryIds.values()) {
      for (const run of await this.dependencies.runStore.listActive(repository)) {
        const source = this.sources.get(run.identity.sourceId);
        try {
          // Mark stopped before killing the window (same race-prevention as cleanupFromAction).
          const stopped = await this.dependencies.runStore.finishActive(run.identity, run.claimedAt, {
            status: "stopped",
            completedAt: this.now().toISOString(),
          });
          if (run.worker) await this.dependencies.agentLauncher.stop?.(run.worker, run);
          if (run.workspace) await this.dependencies.workspaceProvider.cleanup?.(run.workspace, run);
          if (run.workspace) await this.dependencies.runStore.markWorkspaceCleaned(run.identity, run.claimedAt, this.now().toISOString());
          if (source && stopped) await this.report(source, "stopped", stopped);
        } catch (error) {
          this.dependencies.logger.error("Could not stop active run", {
            runId: run.id,
            itemId: run.item.id,
            title: run.item.title,
            error: messageFor(error),
          });
        }
      }
    }
  }

  private startObservingWorker(source: WorkSource, run: RunRecord): void {
    const observer = this.observeWorker(source, run).catch((error: unknown) => {
      this.dependencies.logger.error("Task relay worker observation failed unexpectedly", {
        runId: run.id,
        itemId: run.item.id,
        title: run.item.title,
        error: messageFor(error),
      });
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
      if (!completion) return;
      await this.finishObservedRun(source, run, completion.status, completion.error);
    } catch (error) {
      await this.finishObservedRun(source, run, "failed", `Worker observation failed: ${messageFor(error)}`);
    } finally {
      this.locallyObservedRuns.delete(generation);
    }
  }

  /**
   * A process restart loses in-memory child handles. Runs that never reached a
   * worker cannot recover, while adapter-specific reconciliation can determine
   * whether an already-running persisted worker has since exited.
   */
  private async reconcilePersistedRuns(triggers: readonly TriggerDefinition[]): Promise<void> {
    if (!this.dependencies.runStore.listActive) return;
    const repositories = new Map<string, TriggerDefinition["repository"]>();
    for (const trigger of triggers) repositories.set(`${trigger.repository.id}\u0000${trigger.repository.root}`, trigger.repository);
    for (const repository of repositories.values()) {
      for (const run of await this.dependencies.runStore.listActive(repository)) {
        if (this.locallyObservedRuns.has(runGeneration(run))) continue;
        const source = this.sources.get(run.identity.sourceId);
        if (!source) continue;
        if (!run.worker) {
          await this.finishObservedRun(source, run, "failed", "Relay restarted before the worker was launched.");
          continue;
        }
        try {
          const completion = await this.dependencies.agentLauncher.reconcile?.(run.worker, run);
          if (completion) await this.finishObservedRun(source, run, completion.status, completion.error);
        } catch (error) {
          await this.finishObservedRun(source, run, "failed", `Worker reconciliation failed: ${messageFor(error)}`);
        }
      }
    }
  }

  private async finishObservedRun(source: WorkSource, observed: RunRecord, status: "succeeded" | "failed", error?: string): Promise<void> {
    const current = await this.dependencies.runStore.finishActive(observed.identity, observed.claimedAt, {
      status,
      error,
      completedAt: this.now().toISOString(),
    });
    if (current) await this.report(source, status, current, error);
  }

  private async report(source: WorkSource, type: SourceEvent["type"], run: RunRecord, error?: string): Promise<boolean> {
    try {
      await source.report({
        type,
        sourceId: source.id,
        run,
        occurredAt: this.now().toISOString(),
        error,
      });
      return true;
    } catch (reportError) {
      // A failed notification must not undo a successfully claimed or launched run.
      this.dependencies.logger.warn("Work source event reporting failed", {
        runId: run.id,
        itemId: run.item.id,
        title: run.item.title,
        type,
        error: messageFor(reportError),
      });
      return false;
    }
  }
}

function actionExecutionId(trigger: TriggerDefinition, item: WorkItem, actionId: string, workerId?: string, workerGeneration?: string): string {
  const policy = trigger.firePolicy ?? "once-per-match";
  const occurrence = policy === "every-poll"
    ? randomUUID()
    : policy === "on-change"
      ? actionFingerprint(trigger, item)
      : "item";
  // A persistent worker can be reopened with the same logical worker ID. A
  // worker-target action such as cleanup must run once for each launch
  // generation, not once forever for that ID.
  return JSON.stringify([trigger.repository.id, trigger.repository.root, trigger.id, item.sourceId, item.id, actionId, workerId ?? "", workerGeneration ?? "", occurrence]);
}

function actionFingerprint(trigger: TriggerDefinition, item: WorkItem): string {
  return createHash("sha256").update(JSON.stringify({ match: trigger.selector ?? {}, item })).digest("hex");
}

function normaliseConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Trigger maxConcurrent must be a positive integer");
  }
  return value;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runGeneration(run: Pick<RunRecord, "id" | "claimedAt">): string {
  return `${run.id}\u0000${run.claimedAt}`;
}

function isPersistentWorker(run: RunRecord): boolean {
  return run.worker?.metadata?.persistent === true;
}


/**
 * Workflows reuse the trigger-shaped plumbing for discovery, worker resolution,
 * and launching. The derived trigger is never persisted as configuration; it
 * exists so one engine serves both models.
 */
function workflowAsTrigger(workflow: WorkflowDefinition, jobId?: string): TriggerDefinition {
  return {
    id: jobId ? `${workflow.id}:${jobId}` : workflow.id,
    sourceId: workflow.sourceId,
    repository: workflow.repository,
    enabled: workflow.enabled,
    selector: workflow.selector,
    maxConcurrent: workflow.maxConcurrent,
    targets: workflow.targets,
    firePolicy: workflow.firePolicy,
    metadata: workflow.metadata,
  };
}

/** A concurrency group is per item unless its template says otherwise. */
function renderGroup(template: string, item: WorkItem): string {
  return Handlebars.compile(template, { noEscape: true })({ item, id: item.id, title: item.title });
}

/** Earlier job results, shaped as action outputs so `{ action: <id> }` refs work. */
function actionOutputsOf(run: WorkflowRunRecord): Record<string, ActionResult> {
  const outputs: Record<string, ActionResult> = {};
  for (const [id, state] of Object.entries(run.jobs)) {
    if (state.status === "pending") continue;
    outputs[id] = {
      status: state.status === "skipped" || state.status === "omitted" ? "skipped" : "succeeded",
      output: {
        ...state.outputs,
        ...(state.runId ? { runId: state.runId } : {}),
        ...(state.workerId ? { workerId: state.workerId } : {}),
      },
      ...(state.message ? { message: state.message } : {}),
    };
  }
  return outputs;
}

function stringOutput(result: ActionResult, key: string): string | undefined {
  const value = result.output?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Only JSON-safe scalars and containers reach the expression context. */
function jsonOutputs(result: ActionResult): Record<string, unknown> | undefined {
  if (!result.output) return undefined;
  const entries = Object.entries(result.output).filter(([, value]) => typeof value !== "function" && typeof value !== "symbol");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Outputs an agent reported for itself through `relay signal`. */
function signalOutputs(run: RunRecord): Record<string, unknown> | undefined {
  const value = run.worker?.metadata?.outputs;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
