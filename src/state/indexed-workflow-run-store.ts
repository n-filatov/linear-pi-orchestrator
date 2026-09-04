import type {
  RepositoryScope,
  WorkflowJobTransition,
  WorkflowRunIdentity,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkItem,
} from "../domain/types.js";
import { GlobalWorkflowRegistry } from "./global-worker-registry.js";

/**
 * Keeps the repository JSON ledger authoritative while updating the global
 * SQLite read model after every workflow transition.
 */
export class IndexedWorkflowRunStore implements WorkflowRunStore {
  constructor(
    private readonly store: WorkflowRunStore,
    private readonly registry: GlobalWorkflowRegistry,
    private readonly repository: RepositoryScope,
    /** Indexing is best-effort; repository state is already committed first. */
    private readonly onIndexError?: (error: unknown, run: WorkflowRunRecord) => void,
  ) {}

  async openWorkflowRun(input: { identity: WorkflowRunIdentity; item: WorkItem; startedAt: string; timeoutAt?: string; concurrencyGroup?: string }): Promise<WorkflowRunRecord> {
    const run = await this.store.openWorkflowRun(input);
    this.sync(run, "workflow.opened");
    return run;
  }

  findRunningInGroup(repository: RepositoryScope, group: string): Promise<readonly WorkflowRunRecord[]> {
    return this.store.findRunningInGroup(repository, group);
  }

  async retryWorkflowJobs(identity: WorkflowRunIdentity, jobIds: readonly string[] | undefined, at: string): Promise<WorkflowRunRecord | undefined> {
    const run = await this.store.retryWorkflowJobs(identity, jobIds, at);
    if (run) this.sync(run, "workflow.retried", { jobIds: jobIds ? [...jobIds] : undefined });
    return run;
  }

  findWorkflowRun(identity: WorkflowRunIdentity): Promise<WorkflowRunRecord | undefined> {
    return this.store.findWorkflowRun(identity);
  }

  latestWorkflowRun(identity: Omit<WorkflowRunIdentity, "occurrence">): Promise<WorkflowRunRecord | undefined> {
    return this.store.latestWorkflowRun(identity);
  }

  async updateWorkflowJob(identity: WorkflowRunIdentity, jobId: string, transition: WorkflowJobTransition): Promise<WorkflowRunRecord | undefined> {
    const run = await this.store.updateWorkflowJob(identity, jobId, transition);
    if (run) this.sync(run, "workflow.job.updated", { jobId, status: transition.status }, jobId);
    return run;
  }

  async finishWorkflowRun(identity: WorkflowRunIdentity, status: "succeeded" | "failed", completedAt: string): Promise<WorkflowRunRecord | undefined> {
    const run = await this.store.finishWorkflowRun(identity, status, completedAt);
    if (run) this.sync(run, "workflow.finished", { status });
    return run;
  }

  async listWorkflowRuns(repository: RepositoryScope): Promise<readonly WorkflowRunRecord[]> {
    const runs = await this.store.listWorkflowRuns(repository);
    try { this.registry.importRuns(runs, { repository: this.repository }); }
    catch (error) { for (const run of runs) this.onIndexError?.(error, run); }
    return runs;
  }

  private sync(run: WorkflowRunRecord, type: string, data?: Record<string, unknown>, jobId?: string): void {
    try {
      this.registry.syncRun(run, { repository: this.repository });
      this.registry.appendEvent(run.id, type, run.updatedAt, data, jobId);
    } catch (error) {
      // Never turn a successful state.json transition into a failed dispatch
      // merely because the rebuildable global read model is unavailable.
      this.onIndexError?.(error, run);
    }
  }
}
