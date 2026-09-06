import PQueue from "p-queue";
import { ExecuteJob, ManageWorkers, WorkflowEngine, legacyPipelineToWorkflow, type ExplicitJobOutcome, type TargetJobResult } from "@task-relay/application";
import { jobOutcome, type JobOutcome } from "../application/action-outcome.js";
import { resolveWorkflowInputs } from "../workflows/input-resolver.js";
import { expressionContexts } from "../workflows/reconciler.js";
import { isVersionedActionPlugin } from "../plugins/index.js";
import { PollSchedule } from "../application/poll-schedule.js";
import { PollTriggers } from "../application/poll-triggers.js";
import { InMemoryWorkflowRunStore } from "../application/in-memory-workflow-run-store.js";
import { createHash, randomUUID } from "node:crypto";

import {
  isTerminalWorkItem,
  type AgentLauncher,
  type RelayLogger,
  type RunRecord,
  type RunStore,
  type TriggerDefinition,
  type WorkItem,
  type WorkflowDefinition,
  type WorkflowJobDefinition,
  type WorkflowJobStatus,
  type WorkflowRunRecord,
  type WorkflowRunStore,
  type WorkSource,
  type WorkspaceProvider,
  isActiveRun,
} from "../domain/index.js";
import { decideJob, jobInstances, jobTimedOut, runOutcome, timedOut, type JobDecision } from "../workflows/reconciler.js";
import Handlebars from "handlebars";
import { assertPluginJson, type ActionContext, type ActionResult, type AnyActionPlugin, type LaunchWorkerActionRequest, type PluginJsonObject, type RelayPluginRegistry, type WorkerRef } from "../plugins/index.js";
import type { JsonValue } from "../state/store.js";

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
  /** Omitted for explicit once/test invocations. */
  pollInterval?: (sourceId: string) => number;
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
  attemptId?: string;
  leaseExpiresAt?: string;
  input?: JsonValue;
}

export interface ActionInvocationStore {
  getActionExecution?(id: string): Promise<{ status: string; output?: unknown; error?: unknown; attemptId?: string; leaseExpiresAt?: string } | undefined>;
  claimActionExecution(claim: ActionInvocationClaim): Promise<{ claimedAt: string; attemptId?: string; leaseExpiresAt?: string } | undefined>;
  finishActionExecution(id: string, claimedAt: string, transition: { status: "succeeded" | "failed" | "skipped"; completedAt: string; output?: unknown; error?: unknown }, expectedAttemptId?: string): Promise<unknown>;
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
  private readonly workers: ManageWorkers;
  private readonly now: () => Date;
  private activeTick: Promise<TickResult> | undefined;
  private stopController = new AbortController();
  private readonly schedule = new PollSchedule();
  private readonly pollTriggers: PollTriggers<TickResult>;
  /** Compatibility embedders may omit durable workflow storage. */
  private readonly workflowRunStore: WorkflowRunStore;

  public constructor(private readonly dependencies: TaskRelayDependencies) {
    const sources = [...dependencies.sources];
    for (const source of sources) {
      if (this.sources.has(source.id)) {
        throw new Error(`Duplicate work source id: ${source.id}`);
      }
      this.sources.set(source.id, source);
    }
    this.now = dependencies.now ?? (() => new Date());
    this.workers = new ManageWorkers({
      sources,
      runStore: dependencies.runStore,
      workspaceProvider: dependencies.workspaceProvider,
      agentLauncher: dependencies.agentLauncher,
      logger: dependencies.logger,
      now: this.now,
      oneWorkerPerItem: dependencies.oneWorkerPerItem,
      validateLaunch: dependencies.validateLaunch,
      listRepositories: async () => {
        const repositories = new Map<string, TriggerDefinition["repository"]>();
        for (const trigger of await dependencies.triggers.list()) {
          repositories.set(`${trigger.repository.id}\u0000${trigger.repository.root}`, trigger.repository);
        }
        return [...repositories.values()];
      },
    });
    this.workflowRunStore = dependencies.workflowRuns ?? new InMemoryWorkflowRunStore();
    this.pollTriggers = new PollTriggers<TickResult>({
      stopSignal: this.stopController.signal,
      logger: dependencies.logger,
      createResult: () => ({
        triggersVisited: 0, itemsDiscovered: 0, runsClaimed: 0, runsLaunched: 0,
        skipped: 0, actionsExecuted: 0, actionsFailed: 0, items: [],
      }),
      markExpiredAttempts: () => this.markExpiredAttempts(),
      listTriggers: () => dependencies.triggers.list(),
      listWorkflows: () => dependencies.workflows?.list() ?? Promise.resolve([]),
      reconcilePersistedRuns: (bindings) => this.workers.reconcilePersistedRuns(bindings),
      runTrigger: (trigger, result) => this.runTrigger(trigger, result),
      runWorkflow: (workflow, result) => this.runWorkflow(workflow, result),
    });
  }

  /** Returns the in-flight result when a caller invokes tick concurrently. */
  public tick(): Promise<TickResult> {
    if (this.activeTick) return this.activeTick;

    const current = this.pollTriggers.execute().finally(() => {
      this.activeTick = undefined;
    });
    this.activeTick = current;
    return current;
  }

  /** Stops future dispatches. Active workers are only stopped when requested. */
  public async stop(options: StopOptions = {}): Promise<void> {
    this.stopController.abort();
    await this.activeTick;
    await this.workers.stop(options);

    await Promise.all([...this.sources.values()].map(async (source) => source.close?.()));
  }

  // ── Workflows ─────────────────────────────────────────────────────────────

  private async runWorkflow(workflow: WorkflowDefinition, result: TickResult): Promise<void> {
    const source = this.sources.get(workflow.sourceId);
    if (!source) {
      this.dependencies.logger.error("Configured workflow has no matching work source", { workflowId: workflow.id, sourceId: workflow.sourceId });
      return;
    }
    const runs = this.workflowRunStore;

    // Durable runs are advanced independently of current discovery. This is
    // the key recovery guarantee: a source outage or item leaving its match
    // set cannot strand an active workflow deadline.
    const engine = this.workflowEngine(result);
    const active = (await runs.listWorkflowRuns(workflow.repository)).filter((run) => run.identity.workflowId === workflow.id && run.status === "running");
    const observed = new Set(active.map((run) => occurrenceKey(run.item, run.identity.occurrence)));
    for (const run of active) {
      if (this.stopController.signal.aborted) return;
      await engine.execute({ workflow: run.definition ?? workflow, item: run.item, result, persisted: run });
    }
    if (!this.schedule.due(`workflow:${workflow.id}`, this.now().getTime(), this.dependencies.pollInterval?.(workflow.sourceId))) return;

    let items: readonly WorkItem[];
    try {
      items = await source.discover({ trigger: workflowAsTrigger(workflow), signal: this.stopController.signal });
    } catch (error) {
      this.dependencies.logger.error("Work source discovery failed", { workflowId: workflow.id, sourceId: source.id, error: messageFor(error) });
      return;
    }
    result.itemsDiscovered += items.length;
    const queue = new PQueue({ concurrency: workflow.concurrency ? 1 : normaliseConcurrency(workflow.maxConcurrent) });
    for (const item of items) {
      if (observed.has(occurrenceKey(item))) continue;
      void queue.add(async () => engine.execute({ workflow, item, result })).catch((error: unknown) => {
        this.dependencies.logger.error("Workflow reconciliation failed unexpectedly", { workflowId: workflow.id, itemId: item.id, title: item.title, error: messageFor(error) });
      });
    }
    await queue.onIdle();
  }

  /** Composition adapter: application owns workflow decisions, host owns runtime effects. */
  private workflowEngine(result: TickResult): WorkflowEngine {
    const actions = this.dependencies.actionPlugins;
    const runs = this.workflowRunStore;
    return new WorkflowEngine({
      runs,
      source: (sourceId) => this.sources.get(sourceId),
      actions: actions ? {
        action: (use) => actions.action(use),
        revision: (use) => actions.revision(use),
        parseActionConfig: (use, value) => actions.parseActionConfig(use, value),
        parseActionOutput: (use, value) => actions.parseActionOutput(use, value) as Record<string, unknown>,
      } : undefined,
      operationContext: ({ workflow, item, job, run, attempt }) => {
        const source = this.sources.get(workflow.sourceId);
        if (!source) throw new Error(`Workflow source '${workflow.sourceId}' is unavailable.`);
        return this.actionContext(source, workflowAsTrigger(workflow, job.id), item, job.id,
          JSON.stringify([run.id, job.id]), actionOutputsOf(run), result, undefined, workflow.id, attempt);
      },
      executeJob: ({ workflow, source, item, job, identity, run, outputs }) =>
        this.executeWorkflowJob(workflow, source, item, job, identity, runs, outputs as Record<string, ActionResult>, result),
      refreshJobs: ({ workflow, run }) => this.refreshWorkflowJobs(workflow, run, runs),
      stopWorker: async ({ workflow, item, state }) => { await this.workers.stopWorker(workflowAsTrigger(workflow), item, {}, { workerId: state.workerId! }); },
      now: this.now,
      signal: this.stopController.signal,
      logger: this.dependencies.logger,
      emit: (target, trigger, item, status, reason, workerId) => this.recordItemOutcome(target as TickResult, trigger, item, status, reason, workerId),
      decisions: { decideJob, jobInstances, jobTimedOut, runOutcome, timedOut },
    });
  }

  private async markExpiredAttempts(): Promise<void> {
    const at = this.now().toISOString();
    const workflowStore = this.dependencies.workflowRuns as (WorkflowRunStore & {
      markExpiredWorkflowJobClaimsNeedsAttention?: (at: string) => Promise<unknown>;
    }) | undefined;
    await workflowStore?.markExpiredWorkflowJobClaimsNeedsAttention?.(at);
    const actionStore = this.dependencies.actionExecutions as (ActionInvocationStore & {
      markExpiredActionExecutionsNeedsAttention?: (at: string) => Promise<unknown>;
    }) | undefined;
    await actionStore?.markExpiredActionExecutionsNeedsAttention?.(at);
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
        expectedAttemptId: state.attemptId,
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
    const revisions = workflow.metadata?.pluginRevisions as Record<string, string> | undefined;
    if (!plugin || revisions?.[job.use] && revisions[job.use] !== registry.revision(job.use)) {
      return runs.updateWorkflowJob(identity, job.id, { status: "pending", needsAttention: true,
        message: `Install the recorded plugin revision for '${job.use}' before resuming this run.`, at: this.now().toISOString() });
    }
    const compatibility = legacyPipelineCompatibility(workflow);
    // Keep the old trigger id and action invocation key for normalized
    // pipelines. This lets a restarted unified executor see an invocation
    // claimed by the pre-workflow path, including worker generations.
    const trigger = workflowAsTrigger(workflow, compatibility ? undefined : job.id);
    if (compatibility?.firePolicy) trigger.firePolicy = compatibility.firePolicy;
    const executionId = compatibility
      ? actionExecutionId(trigger, item, job.id)
      : JSON.stringify([identity.repository.id, identity.repository.root, workflow.id, identity.itemId, identity.occurrence, job.id]);
    const startedAt = Date.now();
    let storedAttemptId: string | undefined;
    let updated: WorkflowRunRecord | undefined;
    let selected: JobOutcome | undefined;
    let selectedResult: ActionResult | undefined;
    let targetRuns: readonly RunRecord[] = [];
    let parsedInput: unknown;
    let itemActionClaim: { claimedAt: string; attemptId?: string; leaseExpiresAt?: string } | undefined;
    let itemActionSaved: Awaited<ReturnType<NonNullable<ActionInvocationStore["getActionExecution"]>>> | undefined;
    try {
      const cachedTargets = new Map<RunRecord, { id: string; saved?: Awaited<ReturnType<NonNullable<ActionInvocationStore["getActionExecution"]>>>; claim?: { claimedAt: string; attemptId?: string; leaseExpiresAt?: string } }>();
      const executor = new ExecuteJob<unknown, PluginJsonObject, RunRecord>({
        resolveInput: async () => {
          const current = await runs.findWorkflowRun(identity);
          const state = current?.jobs[job.id];
          if (state && Object.prototype.hasOwnProperty.call(state, "input")) return state.input;
          // Legacy trigger actions use Handlebars (`{{item.id}}`) and pass
          // that syntax to the action adapter. Running the raw config through
          // the typed `${{ ... }}` resolver would reject ordinary Handlebars
          // closing braces before the legacy plugin can render them.
          if (compatibility) return job.config ?? {};
          const contexts = expressionContexts(item, job, current?.jobs ?? {}, jobInstances(workflow.jobs));
          return resolveWorkflowInputs(job.config ?? {}, {
            item, trigger: { payload: item.triggerEvent?.payload ?? item }, repository: workflow.repository, matrix: job.matrix,
            needs: contexts.needs as Record<string, { outputs: Record<string, unknown> }>,
          }, { jobId: job.id, declaredNeeds: job.needs?.map((need) => need.job) });
        },
        parseInput: (input) => {
          parsedInput = registry.parseActionConfig(job.use, input);
          return parsedInput;
        },
        claimJob: async (config) => {
          const attemptId = randomUUID();
          const leaseExpiresAt = new Date(this.now().getTime() + ATTEMPT_LEASE_MS).toISOString();
          if (runs.claimWorkflowJob) {
            const claimed = await runs.claimWorkflowJob(identity, job.id, { at: this.now().toISOString(), attemptId, input: config, leaseExpiresAt });
            if (!claimed) return undefined;
            storedAttemptId = attemptId;
          }
          if (compatibility && !plugin.target && this.dependencies.actionExecutions) {
            itemActionSaved = await this.dependencies.actionExecutions.getActionExecution?.(executionId);
            if (itemActionSaved?.status !== "succeeded") {
              itemActionClaim = await this.claimActionExecution(executionId, trigger, item, job.id, config);
              if (!itemActionClaim) return undefined;
            }
          }
          return { attemptId, leaseExpiresAt };
        },
        ...(plugin.target === "worker" ? { listTargets: async () => targetRuns = await this.workerTargetsForAction(trigger, item, parsedInput, outputs) } : {}),
        ...(plugin.target === "worker" ? { noTargetsOutcome: () => ({ status: "skipped" as const, message: plugin.use === "cleanup" ? "No matching workers." : "No matching worker is running." }) } : {}),
        claimTarget: async (target, config) => {
          const id = compatibility
            ? actionExecutionId(trigger, item, job.id, target.worker?.id, target.claimedAt)
            : JSON.stringify([executionId, target.worker?.id, target.claimedAt]);
          const saved = await this.dependencies.actionExecutions?.getActionExecution?.(id);
          if (saved?.status === "succeeded") {
            cachedTargets.set(target, { id, saved });
            return { attemptId: saved.attemptId ?? `saved:${id}`, leaseExpiresAt: saved.leaseExpiresAt };
          }
          const claim = await this.claimActionExecution(id, trigger, item, job.id, config);
          if (claim) cachedTargets.set(target, { id, claim });
          return claim && { attemptId: claim.attemptId ?? claim.claimedAt, leaseExpiresAt: claim.leaseExpiresAt };
        },
        execute: async ({ attempt, target, targetAttempt, signal }, config) => {
          const cached = target ? cachedTargets.get(target) : undefined;
          if (cached?.saved?.status === "succeeded") return cached.saved.output as ExplicitJobOutcome<unknown>;
          if (!target && itemActionSaved?.status === "succeeded") return { status: "succeeded", output: itemActionSaved.output };
          const context = this.actionContext(source, trigger, item, job.id, executionId, outputs, result, target, workflow.id,
            targetAttempt ? { attemptId: targetAttempt.attemptId, leaseExpiresAt: targetAttempt.leaseExpiresAt } :
              { attemptId: storedAttemptId ?? attempt.attemptId, leaseExpiresAt: attempt.leaseExpiresAt });
          context.signal = signal;
          context.inputsResolved = !compatibility && isVersionedActionPlugin(plugin);
          return Promise.resolve(plugin.execute(context, config));
        },
        adaptOutcome: (raw) => validateActionOutcome(plugin, registry, raw) as ExplicitJobOutcome<unknown>,
        parseOutput: (output) => {
          const parsed = registry.parseActionOutput(job.use, output) as PluginJsonObject;
          assertPluginJson(parsed, `action '${job.use}' output`);
          return parsed;
        },
        heartbeat: async ({ attempt, target, targetAttempt }) => {
          if (storedAttemptId) await this.renewWorkflowJobLease(identity, job.id, storedAttemptId, runs);
          const cached = target ? cachedTargets.get(target) : undefined;
          if (cached?.claim && targetAttempt) await this.renewActionExecutionLease(cached.id, targetAttempt.attemptId, targetAttempt.leaseExpiresAt);
        },
        heartbeatIntervalMs: Math.max(1_000, Math.floor(ATTEMPT_LEASE_MS / 2)),
        finishTarget: async (target, targetAttemptId, outcome) => {
          const cached = cachedTargets.get(target);
          if (!cached?.claim) return;
          await this.finishActionExecution(cached.id, cached.claim.claimedAt,
            outcome.status === "failed" ? "failed" : outcome.status === "skipped" || outcome.status === "deferred" ? "skipped" : "succeeded",
            JSON.parse(JSON.stringify(outcome)) as Record<string, unknown>, undefined, targetAttemptId);
        },
        finishUncertain: async (_attemptId, error, targetResults) => {
          for (const cached of cachedTargets.values()) {
            if (cached?.claim) {
              await this.finishActionExecution(cached.id, cached.claim.claimedAt, "failed", undefined, error, cached.claim.attemptId);
            }
          }
          updated = await runs.updateWorkflowJob(identity, job.id, {
            status: compatibility ? "failed" : "started", expectedAttemptId: storedAttemptId, needsAttention: !compatibility,
            message: `Execution outcome is uncertain: ${error}`, at: this.now().toISOString(), attempted: true,
            outputs: targetOutputs(targetResults),
          });
          if (compatibility && !plugin.target && itemActionClaim) {
            await this.finishActionExecution(executionId, itemActionClaim.claimedAt, "failed", undefined, error, itemActionClaim.attemptId);
          }
        },
        finishJob: async (_attemptId, outcome, targetResults) => {
          const actionResults = targetResults.length
            ? targetResults.map(({ outcome: targetOutcome }) => jobOutcome(plugin, targetOutcome))
            : [jobOutcome(plugin, outcome)];
          selected = actionResults.find((candidate) => candidate.status === "failed")
            ?? actionResults.find((candidate) => candidate.status === "pending" || candidate.status === "started")
            ?? actionResults.find((candidate) => candidate.status === "succeeded") ?? actionResults[0]!;
          // Legacy launch actions historically completed once the worker was
          // handed to the launcher. Their runId output represented the worker
          // generation, not a pending workflow operation.
          if (compatibility && selected.status === "started") selected = { ...selected, status: "succeeded" };
          selectedResult = { ...selected.result };
          if (plugin.target === "worker") selectedResult.output = {
            ...selectedResult.output,
            targets: targetResults.map(({ target, outcome: targetOutcome }) => ({ workerId: target.worker?.id, status: jobOutcome(plugin, targetOutcome).status, output: targetOutcome.output })),
          };
          outputs[job.id] = selectedResult;
          const runId = stringOutput(selectedResult, "runId");
          const workerId = stringOutput(selectedResult, "workerId");
          updated = await runs.updateWorkflowJob(identity, job.id, {
            status: selected.status, expectedAttemptId: storedAttemptId, retryAt: selected.retryAt, operation: selected.operation,
            error: selected.error, message: selectedResult.message, runId, workerId, outputs: jsonOutputs(selectedResult),
            at: this.now().toISOString(), attempted: true,
          });
          if (compatibility && !plugin.target && itemActionClaim) {
            await this.finishActionExecution(executionId, itemActionClaim.claimedAt,
              selected.status === "failed" ? "failed" : selectedResult.status,
              selectedResult.output, selectedResult.message, itemActionClaim.attemptId);
          }
          if (compatibility && plugin.target && targetResults.length === 0 && this.dependencies.actionExecutions) {
            const claim = await this.claimActionExecution(executionId, trigger, item, job.id, parsedInput);
            if (claim) await this.finishActionExecution(executionId, claim.claimedAt, selected.status === "failed" ? "failed" : selectedResult.status,
              selectedResult.output, selectedResult.message, claim.attemptId);
          }
        },
      });
      const execution = await executor.execute();
      if (execution.kind === "not_claimed") return runs.findWorkflowRun(identity);
      if (execution.kind === "uncertain") {
        if (compatibility) {
          result.actionsExecuted += 1;
          result.actionsFailed += 1;
          this.recordItemOutcome(result, trigger, item, "failed", `${job.id}: ${execution.error}`);
        }
        this.dependencies.logger.warn("Workflow node needs attention", { workflowId: workflow.id, jobId: job.id, error: execution.error });
        return updated;
      }
      if (!selected || !selectedResult) {
        throw new Error(`Workflow node '${job.id}' completed without an action outcome.`);
      }
      const actionResult = selectedResult;
      result.actionsExecuted += 1;
      if (selected!.status === "failed") result.actionsFailed += 1;
      if (actionResult.status === "skipped") result.skipped += 1;
      const workerId = stringOutput(actionResult, "workerId");
      if (job.use !== "launch") {
        const detail = selectedResult.message ?? `${selected!.status}.`;
        this.recordItemOutcome(result, trigger, item, "action", `${job.id}: ${detail}`, workerId);
      }
      this.dependencies.logger.info("Workflow node completed", {
        event: "workflow.node.completed", workflowId: workflow.id, jobId: job.id, actionType: job.use, task: item.id, title: item.title,
        workerId, duration: Date.now() - startedAt, status: selected!.status,
      });
      return updated;
    } catch (error) {
      result.actionsFailed += 1;
      this.dependencies.logger.error("Workflow node failed", {
        event: "workflow.node.failed", workflowId: workflow.id, jobId: job.id, actionType: job.use, task: item.id, title: item.title,
        duration: Date.now() - startedAt, error: messageFor(error),
      });
      this.recordItemOutcome(result, trigger, item, "failed", `${job.id}: ${messageFor(error)}`);
      return runs.updateWorkflowJob(identity, job.id, { status: "failed", expectedAttemptId: storedAttemptId, error: messageFor(error), at: this.now().toISOString(), attempted: true });
    }
  }

  private async runTrigger(trigger: TriggerDefinition, result: TickResult): Promise<void> {
    if (!this.schedule.due(`trigger:${trigger.id}`, this.now().getTime(), this.dependencies.pollInterval?.(trigger.sourceId))) return;
    const source = this.sources.get(trigger.sourceId);
    if (!source) {
      this.dependencies.logger.error("Configured trigger has no matching work source", {
        triggerId: trigger.id,
        sourceId: trigger.sourceId,
      });
      return;
    }

    // A trigger with ordered actions is the legacy spelling of a workflow.
    // Once a durable workflow store is bound, normalize it before execution so
    // discovery and workflow jobs share the same claim/attempt engine. The
    // store-less fallback is retained for embedders still on the old ledger.
    const legacyWorkflow = trigger.actions?.length ? legacyPipelineToWorkflow(trigger) : undefined;
    const workflowEngine = legacyWorkflow ? this.workflowEngine(result) : undefined;
    const observedLegacyOccurrences = new Set<string>();
    if (legacyWorkflow) {
      // A source snapshot may omit an item while its pipeline still owns a
      // live worker. Reconcile those durable runs before discovering new work,
      // just as the native workflow binding does.
      const active = (await this.workflowRunStore.listWorkflowRuns(legacyWorkflow.repository))
        .filter((run) => run.identity.workflowId === legacyWorkflow.id && run.status === "running");
      for (const run of active) {
        observedLegacyOccurrences.add(occurrenceKey(run.item, run.identity.occurrence));
        await workflowEngine!.execute({ workflow: legacyWorkflow, item: run.item, result, persisted: run });
      }
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
        if (legacyWorkflow) {
          if (observedLegacyOccurrences.has(occurrenceKey(item))) return;
          await workflowEngine!.execute({ workflow: legacyWorkflow, item, result });
        }
        else {
          const outcome = await this.workers.dispatch(source, trigger, item);
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

  private actionContext(
    source: WorkSource, trigger: TriggerDefinition, item: WorkItem, actionId: string,
    executionId: string, outputs: Readonly<Record<string, ActionResult>>, result: TickResult,
    run?: RunRecord, triggerId = trigger.id,
    attempt?: { attemptId?: string; leaseExpiresAt?: string },
  ): ActionContext {
    return {
      executionId, actionId, triggerId, attemptId: attempt?.attemptId, leaseExpiresAt: attempt?.leaseExpiresAt,
      repository: trigger.repository, sourceId: source.id,
      item, outputs, targets: trigger.targets?.workers, worker: run?.worker, run,
      signal: this.stopController.signal,
      workers: {
        launch: (request) => this.launchFromAction(source, trigger, item, actionId, request, result, outputs),
        cleanup: (workerId) => this.workers.cleanup(source, trigger, item, workerId),
        resolve: (ref) => this.workers.resolve(trigger, item, outputs, ref),
        exec: (ref, spec) => this.workers.exec(trigger, item, outputs, ref, spec),
        send: (ref, spec) => this.workers.send(trigger, item, outputs, ref, spec),
        capture: (ref, options) => this.workers.capture(trigger, item, outputs, ref, options),
        stop: (ref) => this.workers.stopWorker(trigger, item, outputs, ref),
        recordOutputs: (ref, values) => this.workers.recordOutputs(trigger, item, outputs, ref, values),
      },
    };
  }

  private async launchFromAction(source: WorkSource, trigger: TriggerDefinition, item: WorkItem, actionId: string, request: LaunchWorkerActionRequest, result: TickResult, outputs: Readonly<Record<string, ActionResult>> = {}): Promise<ActionResult> {
    const outcome = await this.workers.launchAction(source, trigger, item, actionId, request, outputs);
    result.runsClaimed += outcome.dispatch.claimed ? 1 : 0;
    result.runsLaunched += outcome.dispatch.launched ? 1 : 0;
    this.recordItemOutcome(result, outcome.trigger, item,
      outcome.dispatch.launched ? "launched" : outcome.dispatch.failed ? "failed" : "skipped",
      outcome.dispatch.reason, outcome.dispatch.run?.worker?.id);
    return outcome.result;
  }

  /** Resolve a worker action using its own worker reference before falling
   * back to the trigger-wide target selector used by older actions. */
  private async workerTargetsForAction(
    trigger: TriggerDefinition,
    item: WorkItem,
    config: unknown,
    outputs: Readonly<Record<string, ActionResult>>,
  ): Promise<readonly RunRecord[]> {
    if (config && typeof config === "object" && !Array.isArray(config)) {
      const reference = (config as Record<string, unknown>).worker;
      if (isWorkerRefValue(reference)) {
        return (await this.workers.resolve(trigger, item, outputs, reference)).map(({ run }) => run);
      }
    }
    return this.workers.targetRuns(trigger, item);
  }

  /** Keep an owned claim alive while a plugin performs a legitimate long call. */
  private async executeWithLease<T>(operation: () => Promise<T>, renewers: readonly (() => Promise<void>)[]): Promise<T> {
    const activeRenewers = renewers.filter(Boolean);
    if (activeRenewers.length === 0) return operation();
    const intervalMs = Math.max(1_000, Math.floor(ATTEMPT_LEASE_MS / 2));
    const timer = setInterval(() => {
      for (const renew of activeRenewers) void renew().catch((error: unknown) => {
        this.dependencies.logger.warn("Could not renew an action attempt lease", { error: messageFor(error) });
      });
    }, intervalMs);
    const maybeUnref = timer as unknown as { unref?: () => void };
    maybeUnref.unref?.();
    try {
      return await operation();
    } finally {
      clearInterval(timer);
    }
  }

  private async renewWorkflowJobLease(identity: WorkflowRunRecord["identity"], jobId: string, attemptId: string, runs: WorkflowRunStore): Promise<void> {
    const store = runs as WorkflowRunStore & {
      renewWorkflowJobLease?: (identity: WorkflowRunRecord["identity"], jobId: string, attemptId: string, leaseExpiresAt: string, at: string) => Promise<unknown>;
    };
    if (!store.renewWorkflowJobLease) return;
    const now = this.now();
    await store.renewWorkflowJobLease(identity, jobId, attemptId,
      new Date(now.getTime() + ATTEMPT_LEASE_MS).toISOString(), now.toISOString());
  }

  private async renewActionExecutionLease(id: string, attemptId?: string, currentLease?: string): Promise<void> {
    if (!attemptId || !this.dependencies.actionExecutions) return;
    const store = this.dependencies.actionExecutions as ActionInvocationStore & {
      renewActionExecutionLease?: (id: string, attemptId: string, leaseExpiresAt: string, at: string) => Promise<unknown>;
    };
    if (!store.renewActionExecutionLease) return;
    const now = this.now();
    // The current deadline is only used to avoid extending a completed call
    // from an outdated heartbeat; the storage adapter still fences by attempt.
    if (currentLease && currentLease <= now.toISOString()) return;
    await store.renewActionExecutionLease(id, attemptId,
      new Date(now.getTime() + ATTEMPT_LEASE_MS).toISOString(), now.toISOString());
  }

  private async claimActionExecution(id: string, trigger: TriggerDefinition, item: WorkItem, actionId: string, input?: unknown): Promise<{ claimedAt: string; attemptId?: string; leaseExpiresAt?: string } | undefined> {
    const claimedAt = this.now().toISOString();
    const attemptId = randomUUID();
    const leaseExpiresAt = new Date(this.now().getTime() + ATTEMPT_LEASE_MS).toISOString();
    if (!this.dependencies.actionExecutions) return { claimedAt, attemptId, leaseExpiresAt };
    const claim: ActionInvocationClaim = {
      idempotencyKey: id, triggerId: trigger.id, sourceId: item.sourceId, itemId: item.id, actionId, claimedAt,
      attemptId, leaseExpiresAt, ...(input === undefined ? {} : { input: input as JsonValue }),
    };
    const claimed = await this.dependencies.actionExecutions.claimActionExecution(claim);
    return claimed ? { claimedAt: claimed.claimedAt, attemptId: claimed.attemptId ?? attemptId, leaseExpiresAt: claimed.leaseExpiresAt ?? leaseExpiresAt } : undefined;
  }

  private async finishActionExecution(id: string, claimedAt: string, status: "succeeded" | "failed" | "skipped", output?: Record<string, unknown>, error?: string, expectedAttemptId?: string): Promise<void> {
    await this.dependencies.actionExecutions?.finishActionExecution(id, claimedAt, { status, output, error, completedAt: this.now().toISOString() }, expectedAttemptId);
  }

  private recordItemOutcome(result: TickResult, trigger: TriggerDefinition, item: WorkItem, status: TickItemOutcome["status"], reason?: string, workerId?: string): void {
    result.items.push({ item: { id: item.id, title: item.title }, triggerId: trigger.id, status, reason, workerId });
  }

}

function actionExecutionId(trigger: TriggerDefinition, item: WorkItem, actionId: string, workerId?: string, workerGeneration?: string): string {
  const policy = trigger.firePolicy ?? "once-per-match";
  // Durable trigger events are the occurrence identity. Subject-level ids are
  // insufficient when a provider reports two changes for the same subject in
  // one page (or after a restart), because the second event would otherwise be
  // incorrectly deduplicated as the first action invocation.
  const occurrence = item.triggerEvent?.id
    ? `event-${item.triggerEvent.id}`
    : policy === "every-poll"
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

/** Lease duration is deliberately finite: an abandoned process becomes
 * inspectable, while expiry never authorises an automatic repeat of an
 * uncertain external effect. */
const ATTEMPT_LEASE_MS = 5 * 60_000;

/** Validate the plugin result before it can enter an idempotency record. */
function validateActionOutcome(plugin: AnyActionPlugin, registry: RelayPluginRegistry, value: unknown): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Action '${plugin.use}' returned an invalid outcome.`);
  const outcome = value as { status?: unknown; output?: unknown; operation?: unknown };
  const statuses = isVersionedActionPlugin(plugin)
    ? ["succeeded", "skipped", "deferred", "running", "failed"]
    : ["succeeded", "skipped"];
  if (typeof outcome.status !== "string" || !statuses.includes(outcome.status)) {
    throw new Error(`Action '${plugin.use}' returned an invalid outcome status.`);
  }
  if (isVersionedActionPlugin(plugin) && outcome.output !== undefined) outcome.output = registry.parseActionOutput(plugin.use, outcome.output);
  assertPluginJson(outcome, `action '${plugin.use}' outcome`);
  return outcome;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWorkerRefValue(value: unknown): value is WorkerRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (typeof record.action === "string" && Object.keys(record).every((key) => key === "action"))
    || (typeof record.workerId === "string" && Object.keys(record).every((key) => key === "workerId"))
    || (record.sourceItem === "current" && Object.keys(record).every((key) => key === "sourceItem" || key === "runs"));
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

function legacyPipelineCompatibility(workflow: WorkflowDefinition): { mode: "legacy-pipeline"; version: 1; triggerId?: string; firePolicy?: TriggerDefinition["firePolicy"] } | undefined {
  const value = workflow.metadata?.legacyPipeline;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { mode?: unknown; version?: unknown; triggerId?: unknown; firePolicy?: unknown };
  return candidate.mode === "legacy-pipeline" && candidate.version === 1
    ? { mode: "legacy-pipeline", version: 1,
      ...(typeof candidate.triggerId === "string" ? { triggerId: candidate.triggerId } : {}),
      ...(candidate.firePolicy === "once-per-match" || candidate.firePolicy === "once-per-item" || candidate.firePolicy === "on-change" || candidate.firePolicy === "every-poll" ? { firePolicy: candidate.firePolicy } : {}),
    }
    : undefined;
}

/** A concurrency group is per item unless its template says otherwise. */
function renderGroup(template: string, item: WorkItem): string {
  return Handlebars.compile(template, { noEscape: true })({ item, id: item.id, title: item.title });
}

/** Earlier job results, shaped as action outputs so `{ action: <id> }` refs work. */
function occurrenceKey(item: WorkItem, persistedOccurrence?: string): string {
  // Versioned trigger events carry their own occurrence identity. Legacy
  // sources have no event id and retain subject-level active-run coalescing.
  return item.triggerEvent?.id ? `${item.id}\u0000${item.triggerEvent.id}` : item.id;
}

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

/** Keep each completed worker effect visible when a later target is uncertain. */
function targetOutputs(results: readonly TargetJobResult<PluginJsonObject, RunRecord>[]): Record<string, unknown> {
  return {
    targets: results.map(({ target, outcome }) => ({
      workerId: target.worker?.id,
      status: outcome.status,
      ...(outcome.output === undefined ? {} : { output: outcome.output }),
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
    })),
  };
}

/** Outputs an agent reported for itself through `relay signal`. */
function signalOutputs(run: RunRecord): Record<string, unknown> | undefined {
  const value = run.worker?.metadata?.outputs;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
