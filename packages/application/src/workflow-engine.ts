import Handlebars from "handlebars";
import type {
  ActionContext,
  AnyActionPlugin,
  ExplicitActionOutcome,
} from "@task-relay/plugin-sdk";
import {
  createWorkflowRunKey,
  isTerminalJobStatus,
  type TriggerDefinition,
  type WorkflowDefinition,
  type WorkflowJobDefinition,
  type WorkflowJobState,
  type WorkflowRunIdentity,
  type WorkflowRunRecord,
  type WorkflowRunStore,
  type WorkItem,
  type WorkSource,
} from "@task-relay/domain";
import type { WorkflowJobOutcome } from "./workflow-outcome.js";
import { ReconcileOperations, type PersistedOperation, type ReconcileOperationsPorts } from "./reconcile-operations.js";

export type WorkflowDecision =
  | { action: "run" }
  | { action: "hold"; reason: string }
  | { action: "settle"; status: "skipped" | "omitted"; reason: string };

export interface WorkflowDecisionServices {
  decideJob(input: { job: WorkflowJobDefinition; states: Readonly<Record<string, WorkflowJobState>>; item: WorkItem; known: ReadonlySet<string>; instances: ReadonlyMap<string, readonly string[]> }): WorkflowDecision;
  jobInstances(jobs: readonly WorkflowJobDefinition[]): ReadonlyMap<string, readonly string[]>;
  jobTimedOut(job: WorkflowJobDefinition, state: WorkflowJobState | undefined, now: Date): boolean;
  runOutcome(jobs: readonly WorkflowJobDefinition[], states: Readonly<Record<string, WorkflowJobState>>): { done: boolean; status: "succeeded" | "failed" };
  timedOut(run: WorkflowRunRecord, now: Date): boolean;
}

/** The result shape is deliberately host-owned; the engine only emits events. */
export interface WorkflowEngineResult {
  skipped: number;
  actionsExecuted: number;
  actionsFailed: number;
  items: Array<{ item: Pick<WorkItem, "id" | "title">; triggerId: string; status: "launched" | "skipped" | "failed" | "action"; reason?: string; workerId?: string }>;
}

export interface WorkflowActionCatalog {
  action(use: string): AnyActionPlugin | undefined;
  revision?(use: string): string | undefined;
  parseActionConfig(use: string, value: unknown): unknown;
  parseActionOutput?(use: string, value: unknown): Record<string, unknown>;
}

export interface WorkflowOperationContext {
  context: ActionContext;
  attempt?: { attemptId: string; leaseExpiresAt?: string };
}

/**
 * Host capabilities required by workflow orchestration. Each operation has a
 * named input and output, so composition roots cannot accidentally bind an
 * unrelated callback with the same generic shape.
 */
export interface WorkflowEnginePorts {
  readonly runs: WorkflowRunStore & {
    renewWorkflowJobLease?(identity: WorkflowRunIdentity, jobId: string, attemptId: string, leaseExpiresAt: string, at: string): Promise<WorkflowRunRecord | undefined>;
    markExpiredWorkflowJobClaimsNeedsAttention?(at: string): Promise<WorkflowRunRecord[]>;
  };
  source(sourceId: string): WorkSource | undefined;
  actions?: WorkflowActionCatalog;
  operationContext(input: { workflow: WorkflowDefinition; item: WorkItem; job: WorkflowJobDefinition; run: WorkflowRunRecord; result: WorkflowEngineResult; attempt?: WorkflowOperationContext["attempt"] }): ActionContext;
  executeJob(input: WorkflowJobExecution): Promise<WorkflowRunRecord | undefined>;
  refreshJobs?(input: { workflow: WorkflowDefinition; run: WorkflowRunRecord }): Promise<WorkflowRunRecord | undefined>;
  stopWorker?(input: { workflow: WorkflowDefinition; item: WorkItem; state: WorkflowJobState }): Promise<void>;
  /**
   * Only a worker that opts in should be stopped just because its workflow
   * run finished or has nothing left to depend on it: a tmux window the user
   * keeps working in, or any other persistent worker meant to outlive its
   * launching run, must never be swept this way. The host decides what "opts
   * in" means (e.g. a `stopWithWorkflowRun` worker metadata flag); this
   * package stays free of any specific harness's conventions.
   */
  shouldStopWithRun?(input: { workflow: WorkflowDefinition; item: WorkItem; state: WorkflowJobState }): Promise<boolean>;
  now(): Date;
  signal?: AbortSignal;
  logger: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void };
  emit(result: WorkflowEngineResult, trigger: TriggerDefinition, item: WorkItem, status: "launched" | "skipped" | "failed" | "action", reason?: string, workerId?: string): void;
  decisions: WorkflowDecisionServices;
}

export interface WorkflowStartInput {
  workflow: WorkflowDefinition;
  item: WorkItem;
  result: WorkflowEngineResult;
  persisted?: WorkflowRunRecord;
}

export interface WorkflowJobExecution {
  workflow: WorkflowDefinition;
  source: WorkSource;
  item: WorkItem;
  job: WorkflowJobDefinition;
  identity: WorkflowRunIdentity;
  run: WorkflowRunRecord;
  outputs: Record<string, unknown>;
  result: WorkflowEngineResult;
}

/** Opens a workflow occurrence and records the immutable definition snapshot. */
export class StartWorkflow {
  public constructor(private readonly ports: WorkflowEnginePorts) {}

  public async execute(input: WorkflowStartInput): Promise<WorkflowRunRecord | undefined> {
    const { workflow, item, result } = input;
    const source = this.ports.source(workflow.sourceId);
    if (!source) {
      this.ports.logger.error("Configured workflow has no matching work source", { workflowId: workflow.id, sourceId: workflow.sourceId });
      return undefined;
    }
    const occurrence = input.persisted?.identity.occurrence ?? await workflowOccurrence(workflow, item, this.ports.runs);
    const identity: WorkflowRunIdentity = { repository: workflow.repository, workflowId: workflow.id, sourceId: item.sourceId, itemId: item.id, occurrence };
    const concurrency = workflow.concurrency;
    const group = concurrency ? renderGroup(concurrency.group, item) : undefined;
    if (group && !input.persisted) {
      const key = createWorkflowRunKey(identity);
      const live = (await this.ports.runs.findRunningInGroup(workflow.repository, group)).filter((other) => other.id !== key);
      if (live.length > 0) {
        if (!concurrency?.cancelInProgress) {
          result.skipped += 1;
          this.ports.emit(result, workflowTrigger(workflow), item, "skipped", `Concurrency group '${group}' is held by ${live.map((run) => run.item.id).join(", ")}.`);
          return undefined;
        }
        for (const other of live) {
          const cancelled = await new CancelWorkflow(this.ports).execute({ workflow, run: other, result });
          if (!cancelled) {
            result.skipped += 1;
            this.ports.emit(result, workflowTrigger(workflow), item, "skipped", `Concurrency group '${group}' could not be safely cancelled.`);
            return undefined;
          }
        }
      }
    }
    const startedAt = this.ports.now().toISOString();
    const existing = input.persisted ?? await this.ports.runs.findWorkflowRun(identity);
    const run = existing ?? await this.ports.runs.openWorkflowRun({
      identity,
      item,
      startedAt,
      ...(workflow.timeoutMs ? { timeoutAt: new Date(this.ports.now().getTime() + workflow.timeoutMs).toISOString() } : {}),
      ...(group ? { concurrencyGroup: group } : {}),
      definition: { ...workflow, metadata: { ...workflow.metadata, pluginRevisions: Object.fromEntries(workflow.jobs.map((job) => [job.use, this.ports.actions?.revision?.(job.use)])) } },
    });
    await source.acknowledge?.(item);
    if (!existing && run.startedAt === startedAt) this.ports.logger.info("Workflow action triggered", { event: "workflow.triggered", workflowId: workflow.id, sourceId: source.id, task: item.id, title: item.title });
    return run;
  }
}

/** Advances one opened run from durable job state, preserving deadlines and fences. */
export class AdvanceWorkflow {
  public constructor(private readonly ports: WorkflowEnginePorts) {}

  public async execute(input: WorkflowStartInput & { run: WorkflowRunRecord }): Promise<WorkflowRunRecord> {
    const source = this.ports.source(input.workflow.sourceId);
    if (!source) return input.run;
    let run = input.run;
    let workflow = run.definition ?? input.workflow;
    const item = run.item;
    const trigger = workflowTrigger(workflow);
    if (run.status !== "running") {
      input.result.skipped += 1;
      this.ports.emit(input.result, trigger, item, "skipped", `Workflow run ${run.identity.occurrence} already ${run.status}.`);
      return run;
    }
    if (run.needsAttention) {
      input.result.skipped += 1;
      this.ports.emit(input.result, trigger, item, "skipped", `Workflow run ${run.identity.occurrence} needs attention: inspect and resolve it before resuming.`);
      return run;
    }
    run = await new ReconcileWorkflowOperations(this.ports).execute({ workflow, source, run, result: input.result });
    run = await this.ports.refreshJobs?.({ workflow, run }) ?? run;
    if (this.ports.decisions.timedOut(run, this.ports.now())) {
      await new CancelWorkflow(this.ports).expire({ workflow, run, result: input.result });
      return (await this.ports.runs.findWorkflowRun(run.identity)) ?? run;
    }
    const instances = this.ports.decisions.jobInstances(workflow.jobs);
    const known = new Set(instances.keys());
    const outputs = actionOutputs(run);
    for (const job of workflow.jobs) {
      if (this.ports.signal?.aborted) break;
      let state = run.jobs[job.id];
      // Ordered trigger pipelines historically retried handled failures on
      // the next poll. Reopen that one job before evaluating the DAG while
      // retaining the failed state for the remainder of this pass so
      // continue-on-error conditions can still traverse it.
      if (isLegacyPipeline(workflow) && state?.status === "failed" && !state.needsAttention) {
        run = await this.ports.runs.retryWorkflowJobs(run.identity, [job.id], this.ports.now().toISOString()) ?? run;
        state = run.jobs[job.id];
      }
      if (this.ports.decisions.jobTimedOut(job, state, this.ports.now())) {
        await new CancelWorkflow(this.ports).cancelJob({ workflow, run, job, result: input.result, reason: "Job timed out.", terminalStatus: "failed" });
        run = await this.ports.runs.findWorkflowRun(run.identity) ?? run;
        input.result.actionsFailed += 1;
        this.ports.emit(input.result, workflowTrigger(workflow), item, "failed", `${job.id}: timed out.`);
        continue;
      }
      if (state?.retryAt && this.ports.now().toISOString() < state.retryAt) continue;
      const decision = this.ports.decisions.decideJob({ job, states: run.jobs, item, known, instances });
      if (decision.action === "hold") continue;
      if (decision.action === "settle") {
        run = await this.ports.runs.updateWorkflowJob(run.identity, job.id, { status: decision.status, message: decision.reason, at: this.ports.now().toISOString(), expectedAttemptId: state?.attemptId }) ?? run;
        input.result.skipped += 1;
        this.ports.emit(input.result, workflowTrigger(workflow), item, "skipped", `${job.id}: ${decision.reason}`);
        continue;
      }
      run = await this.ports.executeJob({ workflow, source, item, job, identity: run.identity, run, outputs, result: input.result }) ?? run;
    }
    await this.stopAbandonedSessionWorkers(workflow, run);
    const outcome = this.ports.decisions.runOutcome(workflow.jobs, run.jobs);
    if (outcome.done) {
      run = await this.ports.runs.finishWorkflowRun(run.identity, outcome.status, this.ports.now().toISOString()) ?? run;
      await stopWorkersLeftByJobs(this.ports, workflow, run);
    }
    return run;
  }

  /**
   * A launch job (e.g. `claude.start-session`) intentionally stays `started`
   * for as long as its worker is persistent: some later job may still depend
   * on it, and `runOutcome` deliberately holds the run open for that reason.
   * But once every *other* declared job has reached a terminal state — nothing
   * left pending, nothing left that could still run or depend on this one —
   * no future tick will ever act on that worker again either. Left alone, the
   * run would stay "running" forever (blocking `oneWorkerPerItem`) because
   * `runOutcome` never sees every job terminal, and nothing else would ever
   * call `stopWorker`. Detecting that dead end here and stopping the worker
   * lets `refreshJobs` observe its terminal status next tick, so the job (and
   * then the run) can finish through the normal path.
   */
  private async stopAbandonedSessionWorkers(workflow: WorkflowDefinition, run: WorkflowRunRecord): Promise<void> {
    if (!this.ports.stopWorker) return;
    const stillOpen = workflow.jobs.filter((job) => run.jobs[job.id]?.status === "started" && run.jobs[job.id]?.workerId);
    if (stillOpen.length === 0) return;
    const openIds = new Set(stillOpen.map((job) => job.id));
    const nothingElsePending = workflow.jobs.every((job) => openIds.has(job.id) || isTerminalJobStatus(run.jobs[job.id]?.status ?? "pending"));
    if (!nothingElsePending) return;
    for (const job of stillOpen) {
      const state = run.jobs[job.id]!;
      try {
        if (!(await this.ports.shouldStopWithRun?.({ workflow, item: run.item, state }))) continue;
        await this.ports.stopWorker({ workflow, item: run.item, state });
      } catch (error) {
        this.ports.logger.warn("Could not stop an abandoned session worker with no remaining dependent job", {
          workflowId: workflow.id, jobId: job.id, workerId: state.workerId, error: messageOf(error),
        });
      }
    }
  }
}

/**
 * A job (e.g. a persistent session launch) can finish successfully while the
 * worker it launched keeps running, waiting for a later step that never
 * happens because the run ended failed, timed out, or was cancelled short of
 * a handoff. Once a run is terminal, nothing else will ever stop that
 * worker, so sweep every job's recorded workerId whenever a run finishes.
 * This is generic, not launch-action-specific: `stopWorker` is a no-op for
 * any worker that is already terminal, including one a successful handoff
 * already finished.
 */
async function stopWorkersLeftByJobs(ports: WorkflowEnginePorts, workflow: WorkflowDefinition, run: WorkflowRunRecord): Promise<void> {
  if (!ports.stopWorker) return;
  for (const job of workflow.jobs) {
    const state = run.jobs[job.id];
    if (!state?.workerId) continue;
    try {
      if (!(await ports.shouldStopWithRun?.({ workflow, item: run.item, state }))) continue;
      await ports.stopWorker({ workflow, item: run.item, state });
    } catch (error) {
      ports.logger.warn("Could not stop a worker left running after its workflow run finished", {
        workflowId: workflow.id, jobId: job.id, workerId: state.workerId, error: messageOf(error),
      });
    }
  }
}

function isLegacyPipeline(workflow: WorkflowDefinition): boolean {
  const marker = workflow.metadata?.legacyPipeline;
  return Boolean(marker && typeof marker === "object" && !Array.isArray(marker)
    && (marker as Record<string, unknown>).mode === "legacy-pipeline"
    && (marker as Record<string, unknown>).version === 1);
}

/** Coordinates start and advance while keeping discovery/scheduling in the host. */
export class WorkflowEngine {
  private readonly starter: StartWorkflow;
  private readonly advancer: AdvanceWorkflow;
  public constructor(private readonly ports: WorkflowEnginePorts) { this.starter = new StartWorkflow(ports); this.advancer = new AdvanceWorkflow(ports); }
  public async execute(input: WorkflowStartInput): Promise<WorkflowRunRecord | undefined> {
    const run = await this.starter.execute(input);
    return run ? this.advancer.execute({ ...input, run }) : undefined;
  }
}

/** Reconciles and cancels durable operation handles without retrying uncertain effects. */
export class ReconcileWorkflowOperations {
  public constructor(private readonly ports: WorkflowEnginePorts) {}
  public async execute(input: { workflow: WorkflowDefinition; source: WorkSource; run: WorkflowRunRecord; result: WorkflowEngineResult }): Promise<WorkflowRunRecord> {
    let run = input.run;
    const jobs = input.workflow.jobs.filter((job) => { const state = run.jobs[job.id]; return state?.status === "started" && Boolean(state.operation) && !state.needsAttention; });
    const servicePorts: ReconcileOperationsPorts<Record<string, unknown>> = {
      listOperations: async (): Promise<readonly PersistedOperation[]> => jobs.map((job) => ({ jobId: job.id, pluginUse: job.use, attempt: attemptOf(run.jobs[job.id]!) ?? { attemptId: "legacy" }, operation: run.jobs[job.id]!.operation })),
      plugin: (use, jobId) => {
        const job = jobs.find((candidate) => candidate.id === jobId) ?? jobs.find((candidate) => candidate.use === use);
        const plugin = job ? this.ports.actions?.action(use) : undefined;
        if (!job || !plugin || plugin.kind !== "action" || !("apiVersion" in plugin)) return undefined;
        return {
          reconcile: async ({ attempt }, operation) => plugin.reconcile ? await plugin.reconcile(this.ports.operationContext({ workflow: input.workflow, item: run.item, job, run, result: input.result, attempt }), operation) as never : Promise.reject(new Error("No reconcile contract.")),
          cancel: async ({ attempt }, operation) => plugin.cancel ? await plugin.cancel(this.ports.operationContext({ workflow: input.workflow, item: run.item, job, run, result: input.result, attempt }), operation) as never : Promise.reject(new Error("No cancel contract.")),
        };
      },
      parseOutput: (output, pluginUse) => this.ports.actions?.parseActionOutput?.(pluginUse ?? "", output) ?? output as Record<string, unknown>,
      transition: async (jobId, expectedAttemptId, transition) => {
        run = await this.ports.runs.updateWorkflowJob(run.identity, jobId, {
          status: transition.status as WorkflowJobState["status"],
          ...(transition.output === undefined ? {} : { outputs: transition.output }),
          ...(transition.operation === undefined ? {} : { operation: transition.operation }),
          ...(transition.retryAt === undefined ? {} : { retryAt: transition.retryAt }),
          ...(transition.error === undefined ? {} : { error: transition.error }),
          ...(transition.message === undefined ? {} : { message: transition.message }),
          ...(transition.needsAttention === undefined ? {} : { needsAttention: transition.needsAttention }),
          at: this.ports.now().toISOString(), expectedAttemptId,
        }) ?? run;
        return run.jobs[jobId]?.attemptId !== expectedAttemptId;
      },
    };
    await new ReconcileOperations(servicePorts).reconcile();
    return run;
  }
}

export class CancelWorkflow {
  public constructor(private readonly ports: WorkflowEnginePorts) {}
  public async execute(input: { workflow: WorkflowDefinition; run: WorkflowRunRecord; result: WorkflowEngineResult }): Promise<boolean> {
    return this.cancel({ ...input, reason: "Superseded by a newer run in the same concurrency group.",
      message: `Cancelled: superseded in concurrency group '${input.run.concurrencyGroup}'.`, emitStatus: "skipped" });
  }
  /**
   * Cancels every non-terminal job of a running workflow run and, once every
   * cancellation is verified, finishes the run as failed. Shared by the
   * concurrency-group supersede path above and by an operator-initiated
   * `relay workflow cancel`.
   */
  public async cancel(input: { workflow: WorkflowDefinition; run: WorkflowRunRecord; result: WorkflowEngineResult; reason: string; message?: string; emitStatus?: "skipped" | "failed" }): Promise<boolean> {
    const recorded = input.run.definition ?? input.workflow;
    let uncertain = false;
    for (const job of recorded.jobs) {
      const state = input.run.jobs[job.id];
      // A job that never even started is still `pending`, not terminal: an
      // operator cancelling the run wants it marked `omitted` too, not left
      // dangling forever after the run itself finishes as failed.
      if (state && isTerminalJobStatus(state.status)) continue;
      const verified = await this.cancelJob({ workflow: recorded, run: input.run, job, state, result: input.result, reason: input.reason });
      uncertain ||= !verified;
    }
    if (uncertain) return false;
    await this.ports.runs.finishWorkflowRun(input.run.identity, "failed", this.ports.now().toISOString());
    await stopWorkersLeftByJobs(this.ports, recorded, input.run);
    input.result.skipped += 1;
    this.ports.emit(input.result, workflowTrigger(input.workflow), input.run.item, input.emitStatus ?? "failed", input.message ?? input.reason);
    return true;
  }
  public async expire(input: { workflow: WorkflowDefinition; run: WorkflowRunRecord; result: WorkflowEngineResult }): Promise<void> {
    let uncertain = false;
    for (const job of input.workflow.jobs) {
      const state = input.run.jobs[job.id];
      if (!state || isTerminalJobStatus(state.status)) continue;
      uncertain ||= !(await this.cancelJob({ workflow: input.workflow, run: input.run, job, state, result: input.result, reason: "Workflow run timed out." }));
    }
    if (uncertain) return;
    await this.ports.runs.finishWorkflowRun(input.run.identity, "failed", this.ports.now().toISOString());
    await stopWorkersLeftByJobs(this.ports, input.workflow, input.run);
    input.result.skipped += 1;
    this.ports.emit(input.result, workflowTrigger(input.workflow), input.run.item, "failed", "Workflow run timed out.");
  }
  public async cancelJob(input: { workflow: WorkflowDefinition; run: WorkflowRunRecord; job: WorkflowJobDefinition; state?: WorkflowJobState; result: WorkflowEngineResult; reason: string; terminalStatus?: "omitted" | "failed" }): Promise<boolean> {
    // A job with no recorded state has never run; treat it as `pending` (as
    // the rest of the engine does) so it can still be settled below, rather
    // than silently reporting success without touching the run at all.
    const state = input.state ?? input.run.jobs[input.job.id] ?? { status: "pending" as const, attempts: 0 };
    if (isTerminalJobStatus(state.status)) return true;
    let uncertain = false;
    if (state.status === "started" && state.workerId) {
      if (!this.ports.stopWorker) uncertain = true;
      else try { await this.ports.stopWorker({ workflow: input.workflow, item: input.run.item, state }); } catch { uncertain = true; }
    }
    if (state.status === "started" && state.operation) {
      const plugin = this.ports.actions?.action(input.job.use);
      if (!plugin || plugin.kind !== "action" || !("apiVersion" in plugin) || !("cancel" in plugin) || typeof plugin.cancel !== "function") uncertain = true;
      else try {
        const raw = validateExplicitOutcome(await plugin.cancel(this.ports.operationContext({ workflow: input.workflow, item: input.run.item, job: input.job, run: input.run, result: input.result, attempt: attemptOf(state) }), state.operation), plugin.use);
        const outcome = operationOutcome(this.ports.actions, plugin, raw);
        if (outcome.status === "started" || outcome.status === "pending" || outcome.status === "failed") uncertain = true;
      } catch { uncertain = true; }
    }
    await this.ports.runs.updateWorkflowJob(input.run.identity, input.job.id, uncertain
      ? { status: "started", needsAttention: true, message: `${input.reason} Cancellation could not be verified; inspect before retrying.`, at: this.ports.now().toISOString(), expectedAttemptId: state.attemptId }
      // A verified cancellation settles the job, so any earlier needsAttention
      // flag (e.g. from a stale reconcile) no longer applies.
      : { status: input.terminalStatus ?? "omitted", message: input.reason, error: input.terminalStatus === "failed" ? input.reason : undefined, needsAttention: false, at: this.ports.now().toISOString(), expectedAttemptId: state.attemptId });
    return !uncertain;
  }
}

function operationOutcome(catalog: WorkflowActionCatalog | undefined, plugin: AnyActionPlugin, raw: ExplicitActionOutcome): WorkflowJobOutcome {
  const output = raw.output === undefined ? undefined : catalog?.parseActionOutput?.(plugin.use, raw.output) ?? raw.output;
  switch (raw.status) {
    case "succeeded": return { status: "succeeded", outputs: output, message: raw.message };
    case "skipped": return { status: "skipped", outputs: output, message: raw.message };
    case "deferred": return { status: "pending", retryAt: raw.retryAt, outputs: output, message: raw.reason };
    case "running": return { status: "started", operation: raw.operation, outputs: output, message: raw.message };
    case "failed": return { status: raw.retryAt ? "pending" : "failed", retryAt: raw.retryAt, outputs: output, error: raw.error };
  }
}

function validateExplicitOutcome(value: unknown, use: string): ExplicitActionOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Action '${use}' returned an invalid outcome.`);
  const outcome = value as Record<string, unknown>;
  const statuses = ["succeeded", "skipped", "deferred", "running", "failed"];
  if (typeof outcome.status !== "string" || !statuses.includes(outcome.status)) throw new Error(`Action '${use}' returned an invalid outcome status.`);
  if (outcome.status === "running" && (!outcome.operation || typeof outcome.operation !== "object" || Array.isArray(outcome.operation))) throw new Error("A running action must return an object operation handle.");
  if ((outcome.status === "deferred" || outcome.status === "failed") && outcome.retryAt !== undefined && !Number.isFinite(Date.parse(String(outcome.retryAt)))) throw new Error("An action retryAt must be a valid timestamp.");
  return value as ExplicitActionOutcome;
}

function attemptOf(state: WorkflowJobState): WorkflowOperationContext["attempt"] | undefined { return state.attemptId ? { attemptId: state.attemptId, leaseExpiresAt: state.leaseExpiresAt } : undefined; }
function workflowTrigger(workflow: WorkflowDefinition, jobId?: string): TriggerDefinition { return { id: jobId ? `${workflow.id}:${jobId}` : workflow.id, sourceId: workflow.sourceId, repository: workflow.repository, enabled: workflow.enabled, selector: workflow.selector, maxConcurrent: workflow.maxConcurrent, targets: workflow.targets, firePolicy: workflow.firePolicy, metadata: workflow.metadata }; }
function renderGroup(template: string, item: WorkItem): string { return Handlebars.compile(template, { noEscape: true })({ item, id: item.id, title: item.title }); }
function actionOutputs(run: WorkflowRunRecord): Record<string, unknown> { return Object.fromEntries(Object.entries(run.jobs).filter(([, state]) => !["pending"].includes(state.status)).map(([id, state]) => [id, { status: state.status === "skipped" || state.status === "omitted" ? "skipped" : "succeeded", output: { ...(state.outputs ?? {}), ...(state.runId ? { runId: state.runId } : {}), ...(state.workerId ? { workerId: state.workerId } : {}) }, ...(state.message ? { message: state.message } : {}) }])); }
async function workflowOccurrence(workflow: WorkflowDefinition, item: WorkItem, runs: WorkflowRunStore): Promise<string> {
  if (item.triggerEvent) return `event-${item.triggerEvent.id}`;
  if ((workflow.firePolicy ?? "once-per-match") === "every-poll") {
    const latest = await runs.latestWorkflowRun({ repository: workflow.repository, workflowId: workflow.id, sourceId: item.sourceId, itemId: item.id });
    if (!latest) return "run-1";
    const previous = Number(/^run-(\d+)$/.exec(latest.identity.occurrence)?.[1] ?? "0");
    return latest.status === "running" ? latest.identity.occurrence : `run-${previous + 1}`;
  }
  return (workflow.firePolicy ?? "once-per-match") === "on-change" ? `change-${JSON.stringify(item)}` : "item";
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
