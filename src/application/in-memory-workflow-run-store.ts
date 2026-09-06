import {
  createWorkflowRunKey,
  isTerminalJobStatus,
  type RepositoryScope,
  type WorkflowDefinition,
  type WorkflowJobState,
  type WorkflowJobTransition,
  type WorkflowRunIdentity,
  type WorkflowRunRecord,
  type WorkflowRunStore,
  type WorkItem,
} from "../domain/index.js";

/**
 * Process-local workflow ledger for programmatic embedders that predate the
 * durable workflow store. Legacy action effects still use their configured
 * invocation ledger; this adapter only keeps the workflow state required by
 * the shared engine while the relay instance is alive.
 */
export class InMemoryWorkflowRunStore implements WorkflowRunStore {
  private readonly records = new Map<string, WorkflowRunRecord>();

  public async openWorkflowRun(input: {
    identity: WorkflowRunIdentity;
    item: WorkItem;
    startedAt: string;
    timeoutAt?: string;
    concurrencyGroup?: string;
    definition?: WorkflowDefinition;
  }): Promise<WorkflowRunRecord> {
    const id = createWorkflowRunKey(input.identity);
    const existing = this.records.get(id);
    if (existing) return existing;
    const record: WorkflowRunRecord = {
      id,
      identity: input.identity,
      item: input.item,
      status: "running",
      jobs: {},
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      ...(input.timeoutAt ? { timeoutAt: input.timeoutAt } : {}),
      ...(input.concurrencyGroup ? { concurrencyGroup: input.concurrencyGroup } : {}),
      ...(input.definition ? { definition: input.definition } : {}),
    };
    this.records.set(id, record);
    return record;
  }

  public async claimWorkflowJob(identity: WorkflowRunIdentity, jobId: string, claim: {
    at: string;
    attemptId: string;
    input?: unknown;
    leaseExpiresAt?: string;
  }): Promise<WorkflowRunRecord | undefined> {
    const current = this.records.get(createWorkflowRunKey(identity));
    if (!current || current.status !== "running") return undefined;
    const old = current.jobs[jobId] ?? { status: "pending", attempts: 0 } satisfies WorkflowJobState;
    if (old.status !== "pending" || old.attemptId || old.needsAttention) return undefined;
    const nextJob: WorkflowJobState = {
      ...old,
      status: "pending",
      attempts: old.attempts + 1,
      startedAt: old.startedAt ?? claim.at,
      attemptId: claim.attemptId,
      ...(claim.input === undefined ? {} : { input: claim.input }),
      ...(claim.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: claim.leaseExpiresAt }),
      attemptHistory: [
        ...(old.attemptHistory ?? []),
        { attemptId: claim.attemptId, claimedAt: claim.at, status: "pending" },
      ],
    };
    return this.save(current, { jobs: { ...current.jobs, [jobId]: nextJob }, updatedAt: claim.at });
  }

  public async findRunningInGroup(repository: RepositoryScope, group: string): Promise<readonly WorkflowRunRecord[]> {
    return [...this.records.values()]
      .filter((run) => run.status === "running" && run.concurrencyGroup === group && sameRepository(run.identity.repository, repository));
  }

  public async retryWorkflowJobs(identity: WorkflowRunIdentity, jobIds: readonly string[] | undefined, at: string): Promise<WorkflowRunRecord | undefined> {
    const current = this.records.get(createWorkflowRunKey(identity));
    if (!current) return undefined;
    const wanted = jobIds?.length ? new Set(jobIds) : undefined;
    const jobs = Object.fromEntries(Object.entries(current.jobs).map(([id, state]) => {
      if (wanted && !wanted.has(id) || !isTerminalJobStatus(state.status) && !state.needsAttention) return [id, state];
      return [id, {
        ...state,
        status: "pending" as const,
        error: undefined,
        message: undefined,
        completedAt: undefined,
        attemptId: undefined,
        needsAttention: undefined,
        retryAt: undefined,
        leaseExpiresAt: undefined,
        operation: undefined,
        runId: undefined,
        workerId: undefined,
      }];
    }));
    return this.save(current, { jobs, status: "running", completedAt: undefined, updatedAt: at });
  }

  public async findWorkflowRun(identity: WorkflowRunIdentity): Promise<WorkflowRunRecord | undefined> {
    return this.records.get(createWorkflowRunKey(identity));
  }

  public async latestWorkflowRun(identity: Omit<WorkflowRunIdentity, "occurrence">): Promise<WorkflowRunRecord | undefined> {
    return [...this.records.values()]
      .filter((run) => sameRepository(run.identity.repository, identity.repository)
        && run.identity.workflowId === identity.workflowId
        && run.identity.sourceId === identity.sourceId
        && run.identity.itemId === identity.itemId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  }

  public async updateWorkflowJob(identity: WorkflowRunIdentity, jobId: string, transition: WorkflowJobTransition): Promise<WorkflowRunRecord | undefined> {
    const current = this.records.get(createWorkflowRunKey(identity));
    if (!current || current.status !== "running") return undefined;
    const old = current.jobs[jobId] ?? { status: "pending", attempts: 0 } satisfies WorkflowJobState;
    if (isTerminalJobStatus(old.status) || old.attemptId !== transition.expectedAttemptId && old.attemptId !== undefined) return undefined;
    const terminal = isTerminalJobStatus(transition.status);
    const history = transition.expectedAttemptId === undefined
      ? old.attemptHistory
      : (old.attemptHistory ?? []).map((entry) => entry.attemptId === transition.expectedAttemptId
        ? { ...entry, status: transition.status, completedAt: transition.at, outcome: terminal ? "completed" as const : entry.outcome }
        : entry);
    const nextJob: WorkflowJobState = {
      ...old,
      status: transition.status,
      startedAt: old.startedAt ?? transition.at,
      completedAt: terminal ? transition.at : undefined,
      attempts: old.attempts + (transition.attempted && !old.attemptId ? 1 : 0),
      ...(transition.expectedAttemptId === undefined ? {} : { attemptId: undefined, leaseExpiresAt: undefined }),
      ...(transition.runId === undefined ? {} : { runId: transition.runId }),
      ...(transition.workerId === undefined ? {} : { workerId: transition.workerId }),
      ...(transition.outputs === undefined ? {} : { outputs: { ...old.outputs, ...transition.outputs } }),
      ...(transition.message === undefined ? {} : { message: transition.message }),
      ...(transition.error === undefined ? {} : { error: transition.error }),
      ...(transition.input === undefined ? {} : { input: transition.input }),
      ...(transition.operation === undefined ? {} : { operation: transition.operation }),
      ...(transition.needsAttention === undefined ? {} : { needsAttention: transition.needsAttention }),
      ...(transition.retryAt === undefined ? {} : { retryAt: transition.retryAt }),
      ...(history === undefined ? {} : { attemptHistory: history }),
    };
    return this.save(current, { jobs: { ...current.jobs, [jobId]: nextJob }, updatedAt: transition.at });
  }

  public async finishWorkflowRun(identity: WorkflowRunIdentity, status: "succeeded" | "failed", completedAt: string): Promise<WorkflowRunRecord | undefined> {
    const current = this.records.get(createWorkflowRunKey(identity));
    if (!current || current.status !== "running") return undefined;
    return this.save(current, { status, completedAt, updatedAt: completedAt });
  }

  public async listWorkflowRuns(repository: RepositoryScope): Promise<readonly WorkflowRunRecord[]> {
    return [...this.records.values()].filter((run) => sameRepository(run.identity.repository, repository));
  }

  private save(current: WorkflowRunRecord, patch: Partial<WorkflowRunRecord>): WorkflowRunRecord {
    const next = { ...current, ...patch };
    this.records.set(current.id, next);
    return next;
  }
}

function sameRepository(left: RepositoryScope, right: RepositoryScope): boolean {
  return left.id === right.id && left.root === right.root;
}
