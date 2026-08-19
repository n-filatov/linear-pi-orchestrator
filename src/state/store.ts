import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { stateDirectory } from "../logging/events.js";
import {
  createRunKey,
  createWorkflowRunKey,
  isActiveRun,
  isTerminalJobStatus,
  workerChildren,
  type RepositoryScope,
  type RunClaim,
  type RunIdentity,
  type RunRecord,
  type RunStore,
  type RunTerminalTransition,
  type WorkerChildHandle,
  type WorkflowJobState,
  type WorkflowJobTransition,
  type WorkflowRunIdentity,
  type WorkflowRunRecord,
  type WorkflowRunStore,
  type WorkItem,
} from "../domain/types.js";

/** JSON-safe data passed between configurable actions. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ActionExecutionStatus = "running" | "succeeded" | "failed" | "skipped";

/**
 * Durable action invocation state. `idempotencyKey` is deliberately supplied
 * by the caller: sources and actions decide when a changed item is a new
 * event. The store guarantees one active/successful execution per key while
 * allowing failed or skipped attempts to be retried.
 */
export interface ActionExecutionRecord {
  /** Equal to `idempotencyKey`; retained as a conventional state-record id. */
  id: string;
  idempotencyKey: string;
  triggerId: string;
  actionId: string;
  sourceId: string;
  itemId: string;
  status: ActionExecutionStatus;
  claimedAt: string;
  updatedAt: string;
  completedAt?: string;
  input?: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
}

export interface ActionExecutionClaimInput {
  idempotencyKey: string;
  triggerId: string;
  actionId: string;
  sourceId: string;
  itemId: string;
  claimedAt: string;
  input?: JsonValue;
}

export interface ActionExecutionTransition {
  status: Exclude<ActionExecutionStatus, "running">;
  completedAt: string;
  output?: JsonValue;
  error?: JsonValue;
}

export interface ActionExecutionFilter {
  triggerId?: string;
  actionId?: string;
  sourceId?: string;
  itemId?: string;
  statuses?: readonly ActionExecutionStatus[];
}

export type WorkerTargetSelection = "latest" | "active" | "all";

/** Finds all runs associated with a single source item. */
export interface RunItemLookup {
  repository: RepositoryScope;
  sourceId: string;
  itemId: string;
  selection?: WorkerTargetSelection;
  /** Defaults to true because this is a general state query, not cleanup. */
  includeCleaned?: boolean;
}

/**
 * Resolves persisted worker owners for an action such as cleanup. A worker can
 * be selected by its source item, explicit worker id, or both (which narrows
 * the result). Already-cleaned workspaces are omitted by default.
 */
export interface WorkerTargetLookup {
  repository: RepositoryScope;
  sourceId?: string;
  itemId?: string;
  workerIds?: readonly string[];
  selection?: WorkerTargetSelection;
  includeCleaned?: boolean;
}

type StateData = {
  version: 1;
  runs: Record<string, RunRecord>;
  actions: Record<string, ActionExecutionRecord>;
  workflows: Record<string, WorkflowRunRecord>;
};

export { type RunRecord } from "../domain/types.js";
export function taskStateKey(identity: RunIdentity): string { return createRunKey(identity); }

/** JSON state with an advisory write lock. One file is used per repository scope. */
export class RepositoryStateStore implements RunStore, WorkflowRunStore {
  readonly directory: string;
  readonly file: string;
  constructor(projectRoot: string) { this.directory = stateDirectory(projectRoot); this.file = join(this.directory, "state.json"); }

  private ensure(): void { mkdirSync(this.directory, { recursive: true }); if (!existsSync(this.file)) writeFileAtomic.sync(this.file, `${JSON.stringify(emptyState())}\n`); }
  private read(): StateData {
    this.ensure();
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StateData>;
      // `actions` and later `workflows` were added without changing the
      // state-file version. Existing repositories therefore read exactly as
      // before, with empty ledgers on first use.
      return { version: 1, runs: value.runs || {}, actions: value.actions || {}, workflows: value.workflows || {} };
    } catch { return emptyState(); }
  }
  async snapshot(): Promise<StateData> { return this.read(); }
  async listRuns(): Promise<RunRecord[]> { return Object.values((await this.snapshot()).runs).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async getRun(id: string): Promise<RunRecord | undefined> { return (await this.snapshot()).runs[id]; }
  async listActionExecutions(filter: ActionExecutionFilter = {}): Promise<ActionExecutionRecord[]> {
    return Object.values((await this.snapshot()).actions)
      .filter((execution) => matchesActionFilter(execution, filter))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  async getActionExecution(idempotencyKey: string): Promise<ActionExecutionRecord | undefined> {
    return (await this.snapshot()).actions[idempotencyKey];
  }
  async findActive(identity: RunIdentity): Promise<RunRecord | undefined> {
    const run = (await this.snapshot()).runs[taskStateKey(identity)];
    return run && isActiveRun(run.status) ? run : undefined;
  }
  async countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">): Promise<number> {
    return (await this.listRuns()).filter((run) => isActiveRun(run.status) && run.identity.repository.id === identity.repository.id && run.identity.repository.root === identity.repository.root && run.identity.sourceId === identity.sourceId && run.identity.triggerId === identity.triggerId).length;
  }
  async findRunsForItem(lookup: RunItemLookup): Promise<RunRecord[]> {
    const includeCleaned = lookup.includeCleaned ?? true;
    return selectRuns(
      (await this.listRuns()).filter((run) => sameRepository(run.identity.repository, lookup.repository)
        && run.identity.sourceId === lookup.sourceId
        && run.identity.itemId === lookup.itemId
        && (includeCleaned || !run.workspaceCleanedAt)),
      lookup.selection ?? "all",
    );
  }
  async findWorkerTargets(lookup: WorkerTargetLookup): Promise<RunRecord[]> {
    const hasWorkerIds = Boolean(lookup.workerIds?.length);
    if (!hasWorkerIds && (!lookup.sourceId || !lookup.itemId)) {
      throw new Error("Worker target lookup requires sourceId and itemId, or at least one workerId.");
    }
    const workerIds = new Set(lookup.workerIds ?? []);
    const includeCleaned = lookup.includeCleaned ?? false;
    return selectRuns(
      (await this.listRuns()).filter((run) => {
        if (!sameRepository(run.identity.repository, lookup.repository) || !run.worker) return false;
        if (!includeCleaned && run.workspaceCleanedAt) return false;
        if (lookup.sourceId && run.identity.sourceId !== lookup.sourceId) return false;
        if (lookup.itemId && run.identity.itemId !== lookup.itemId) return false;
        return !hasWorkerIds || workerIds.has(run.worker.id);
      }),
      lookup.selection ?? "all",
    );
  }
  async claim(claim: RunClaim): Promise<RunRecord | undefined> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read(); const id = taskStateKey(claim.identity); const existing = state.runs[id];
      if (existing && isActiveRun(existing.status)) return undefined;
      const active = Object.values(state.runs).filter((run) => isActiveRun(run.status)
        && run.identity.repository.id === claim.identity.repository.id
        && run.identity.repository.root === claim.identity.repository.root
        && run.identity.sourceId === claim.identity.sourceId
        && run.identity.triggerId === claim.identity.triggerId).length;
      if (active >= claim.maxConcurrent) return undefined;
      const run: RunRecord = { id, identity: claim.identity, item: claim.item, trigger: claim.trigger, agent: claim.agent, status: "claimed", claimedAt: claim.claimedAt, updatedAt: claim.claimedAt };
      state.runs[id] = run; await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`); return run;
    }
    finally { await release(); }
  }
  /** Atomically create a new action execution unless its key was seen before. */
  async claimActionExecution(claim: ActionExecutionClaimInput): Promise<ActionExecutionRecord | undefined> {
    assertActionClaim(claim);
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const previous = state.actions[claim.idempotencyKey];
      // Successful actions and in-flight generations are idempotent. Failed
      // or deliberately skipped attempts may be retried on a later poll.
      if (previous?.status === "running" || previous?.status === "succeeded") return undefined;
      const execution: ActionExecutionRecord = {
        id: claim.idempotencyKey,
        idempotencyKey: claim.idempotencyKey,
        triggerId: claim.triggerId,
        actionId: claim.actionId,
        sourceId: claim.sourceId,
        itemId: claim.itemId,
        status: "running",
        claimedAt: claim.claimedAt,
        updatedAt: claim.claimedAt,
        ...(claim.input === undefined ? {} : { input: claim.input }),
      };
      state.actions[execution.idempotencyKey] = execution;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return execution;
    } finally { await release(); }
  }
  /**
   * Atomically terminally transition the one claimed generation of an action.
   * This mirrors `finishActive` and protects against a retry and a late worker
   * completion racing to write different outcomes.
   */
  async finishActionExecution(idempotencyKey: string, claimedAt: string, transition: ActionExecutionTransition): Promise<ActionExecutionRecord | undefined> {
    assertActionTransition(transition);
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const execution = state.actions[idempotencyKey];
      if (!execution || execution.status !== "running" || execution.claimedAt !== claimedAt) return undefined;
      execution.status = transition.status;
      execution.completedAt = transition.completedAt;
      execution.updatedAt = transition.completedAt;
      if (transition.output !== undefined) execution.output = transition.output;
      if (transition.error !== undefined) execution.error = transition.error;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return execution;
    } finally { await release(); }
  }
  /** Short aliases for action implementations that prefer concise persistence calls. */
  async claimAction(claim: ActionExecutionClaimInput): Promise<ActionExecutionRecord | undefined> { return this.claimActionExecution(claim); }
  async finishAction(idempotencyKey: string, claimedAt: string, transition: ActionExecutionTransition): Promise<ActionExecutionRecord | undefined> {
    return this.finishActionExecution(idempotencyKey, claimedAt, transition);
  }
  async finishActive(identity: RunIdentity, claimedAt: string, transition: RunTerminalTransition): Promise<RunRecord | undefined> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const run = state.runs[taskStateKey(identity)];
      if (!run || !isActiveRun(run.status) || run.claimedAt !== claimedAt) return undefined;
      run.status = transition.status;
      run.error = transition.error;
      run.completedAt = transition.completedAt;
      run.updatedAt = transition.completedAt;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return run;
    } finally { await release(); }
  }
  async markWorkspaceCleaned(identity: RunIdentity, claimedAt: string, cleanedAt: string): Promise<RunRecord | undefined> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const run = state.runs[taskStateKey(identity)];
      if (!run || run.claimedAt !== claimedAt) return undefined;
      run.workspaceCleanedAt = cleanedAt;
      run.updatedAt = cleanedAt;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return run;
    } finally { await release(); }
  }
  async recordWorkerChild(identity: RunIdentity, claimedAt: string, child: WorkerChildHandle, recordedAt: string): Promise<RunRecord | undefined> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const run = state.runs[taskStateKey(identity)];
      if (!run || run.claimedAt !== claimedAt || !run.worker) return undefined;
      run.worker = { ...run.worker, metadata: { ...run.worker.metadata, children: [...workerChildren(run.worker), child] } };
      run.updatedAt = recordedAt;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return run;
    } finally { await release(); }
  }
  async recordWorkerOutputs(identity: RunIdentity, claimedAt: string, outputs: Record<string, unknown>, recordedAt: string): Promise<RunRecord | undefined> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const run = state.runs[taskStateKey(identity)];
      if (!run || run.claimedAt !== claimedAt || !run.worker) return undefined;
      const previous = run.worker.metadata?.outputs;
      const merged = previous !== null && typeof previous === "object" && !Array.isArray(previous) ? { ...previous, ...outputs } : { ...outputs };
      run.worker = { ...run.worker, metadata: { ...run.worker.metadata, outputs: merged } };
      run.updatedAt = recordedAt;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return run;
    } finally { await release(); }
  }
  async update(run: RunRecord): Promise<void> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try { const state = this.read(); state.runs[run.id] = run; await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`); }
    finally { await release(); }
  }
  async listActive(repository: RepositoryScope): Promise<readonly RunRecord[]> {
    return (await this.listRuns()).filter((run) => isActiveRun(run.status) && run.identity.repository.id === repository.id && run.identity.repository.root === repository.root);
  }

  // ── Workflow runs ─────────────────────────────────────────────────────────

  async openWorkflowRun(input: { identity: WorkflowRunIdentity; item: WorkItem; startedAt: string; timeoutAt?: string; concurrencyGroup?: string }): Promise<WorkflowRunRecord> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const id = createWorkflowRunKey(input.identity);
      const existing = state.workflows[id];
      if (existing) return existing;
      const created: WorkflowRunRecord = {
        id,
        identity: input.identity,
        item: input.item,
        status: "running",
        jobs: {},
        startedAt: input.startedAt,
        updatedAt: input.startedAt,
        ...(input.timeoutAt ? { timeoutAt: input.timeoutAt } : {}),
        ...(input.concurrencyGroup ? { concurrencyGroup: input.concurrencyGroup } : {}),
      };
      state.workflows[id] = created;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return created;
    } finally { await release(); }
  }

  async findWorkflowRun(identity: WorkflowRunIdentity): Promise<WorkflowRunRecord | undefined> {
    return (await this.snapshot()).workflows[createWorkflowRunKey(identity)];
  }

  async latestWorkflowRun(identity: Omit<WorkflowRunIdentity, "occurrence">): Promise<WorkflowRunRecord | undefined> {
    return Object.values((await this.snapshot()).workflows)
      .filter((run) => sameRepository(run.identity.repository, identity.repository)
        && run.identity.workflowId === identity.workflowId
        && run.identity.sourceId === identity.sourceId
        && run.identity.itemId === identity.itemId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  }

  async updateWorkflowJob(identity: WorkflowRunIdentity, jobId: string, transition: WorkflowJobTransition): Promise<WorkflowRunRecord | undefined> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const run = state.workflows[createWorkflowRunKey(identity)];
      if (!run) return undefined;
      const previous: WorkflowJobState = run.jobs[jobId] ?? { status: "pending", attempts: 0 };
      run.jobs[jobId] = {
        ...previous,
        status: transition.status,
        ...(transition.runId === undefined ? {} : { runId: transition.runId }),
        ...(transition.workerId === undefined ? {} : { workerId: transition.workerId }),
        ...(transition.outputs === undefined ? {} : { outputs: { ...previous.outputs, ...transition.outputs } }),
        ...(transition.message === undefined ? {} : { message: transition.message }),
        // A retry must clear the previous attempt's error, or a job that later
        // succeeds still reads as broken.
        error: transition.error,
        startedAt: previous.startedAt ?? transition.at,
        ...(isTerminalJobStatus(transition.status) ? { completedAt: transition.at } : { completedAt: undefined }),
        attempts: previous.attempts + (transition.attempted ? 1 : 0),
      };
      run.updatedAt = transition.at;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return run;
    } finally { await release(); }
  }

  async finishWorkflowRun(identity: WorkflowRunIdentity, status: "succeeded" | "failed", completedAt: string): Promise<WorkflowRunRecord | undefined> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const run = state.workflows[createWorkflowRunKey(identity)];
      if (!run || run.status !== "running") return undefined;
      run.status = status;
      run.completedAt = completedAt;
      run.updatedAt = completedAt;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return run;
    } finally { await release(); }
  }

  async findRunningInGroup(repository: RepositoryScope, group: string): Promise<readonly WorkflowRunRecord[]> {
    return Object.values((await this.snapshot()).workflows)
      .filter((run) => run.status === "running" && run.concurrencyGroup === group && sameRepository(run.identity.repository, repository))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async retryWorkflowJobs(identity: WorkflowRunIdentity, jobIds: readonly string[] | undefined, at: string): Promise<WorkflowRunRecord | undefined> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read();
      const run = state.workflows[createWorkflowRunKey(identity)];
      if (!run) return undefined;
      const wanted = jobIds && jobIds.length > 0 ? new Set(jobIds) : undefined;
      for (const [jobId, job] of Object.entries(run.jobs)) {
        // Only settled jobs are reset. A live worker keeps its state, so a retry
        // never orphans one or double-launches beside it.
        if (wanted && !wanted.has(jobId)) continue;
        if (!isTerminalJobStatus(job.status)) continue;
        run.jobs[jobId] = { ...job, status: "pending", error: undefined, message: undefined, completedAt: undefined };
      }
      // Reopening the run is the point: a finished run does not advance.
      run.status = "running";
      run.completedAt = undefined;
      run.updatedAt = at;
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return run;
    } finally { await release(); }
  }

  async listWorkflowRuns(repository: RepositoryScope): Promise<readonly WorkflowRunRecord[]> {
    return Object.values((await this.snapshot()).workflows)
      .filter((run) => sameRepository(run.identity.repository, repository))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

function emptyState(): StateData { return { version: 1, runs: {}, actions: {}, workflows: {} }; }

function sameRepository(left: RepositoryScope, right: RepositoryScope): boolean {
  return left.id === right.id && left.root === right.root;
}

function selectRuns(runs: RunRecord[], selection: WorkerTargetSelection): RunRecord[] {
  const sorted = [...runs].sort((left, right) => right.claimedAt.localeCompare(left.claimedAt) || right.updatedAt.localeCompare(left.updatedAt));
  if (selection === "active") return sorted.filter((run) => isActiveRun(run.status));
  return selection === "latest" ? sorted.slice(0, 1) : sorted;
}

function matchesActionFilter(execution: ActionExecutionRecord, filter: ActionExecutionFilter): boolean {
  return (!filter.triggerId || execution.triggerId === filter.triggerId)
    && (!filter.actionId || execution.actionId === filter.actionId)
    && (!filter.sourceId || execution.sourceId === filter.sourceId)
    && (!filter.itemId || execution.itemId === filter.itemId)
    && (!filter.statuses || filter.statuses.includes(execution.status));
}

function assertActionClaim(claim: ActionExecutionClaimInput): void {
  for (const [name, value] of Object.entries({
    idempotencyKey: claim.idempotencyKey,
    triggerId: claim.triggerId,
    actionId: claim.actionId,
    sourceId: claim.sourceId,
    itemId: claim.itemId,
    claimedAt: claim.claimedAt,
  })) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Action execution ${name} must be a non-empty string.`);
  }
  assertJsonValue(claim.input, "input");
}

function assertActionTransition(transition: ActionExecutionTransition): void {
  if (transition.status !== "succeeded" && transition.status !== "failed" && transition.status !== "skipped") {
    throw new Error(`Invalid action execution status: ${String(transition.status)}`);
  }
  if (typeof transition.completedAt !== "string" || transition.completedAt.length === 0) throw new Error("Action execution completedAt must be a non-empty string.");
  assertJsonValue(transition.output, "output");
  assertJsonValue(transition.error, "error");
}

function assertJsonValue(value: unknown, name: string): asserts value is JsonValue | undefined {
  if (value === undefined || isJsonValue(value)) return;
  throw new Error(`Action execution ${name} must be JSON-serialisable data.`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}
