import type {
  RepositoryScope,
  WorkflowJobTransition,
  WorkflowDefinition,
  WorkflowRunIdentity,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkItem,
} from "../domain/types.js";
import { GlobalWorkflowRegistry } from "./global-worker-registry.js";

type ProjectionOutboxStore = {
  enqueueProjection(topic: string, payload: unknown, at: string): Promise<void>;
  pendingProjections(): Promise<Array<{ id: number; topic: string; payload: unknown; createdAt: string }>>;
  acknowledgeProjection(id: number, at: string): Promise<boolean>;
};

/**
 * Keeps the repository SQLite ledger authoritative while updating the global
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

  async openWorkflowRun(input: { identity: WorkflowRunIdentity; item: WorkItem; startedAt: string; timeoutAt?: string; concurrencyGroup?: string; definition?: WorkflowDefinition }): Promise<WorkflowRunRecord> {
    const run = await this.store.openWorkflowRun(input);
    await this.sync(run, "workflow.opened");
    return run;
  }

  async claimWorkflowJob(identity: WorkflowRunIdentity, jobId: string, claim: { at: string; attemptId: string; input?: unknown; leaseExpiresAt?: string }): Promise<WorkflowRunRecord | undefined> {
    if (!this.store.claimWorkflowJob) throw new Error("Workflow store must support atomic job claims.");
    const run = await this.store.claimWorkflowJob(identity, jobId, claim);
    if (run) await this.sync(run, "workflow.job.claimed", { jobId });
    return run;
  }

  async renewWorkflowJobLease(identity: WorkflowRunIdentity, jobId: string, attemptId: string, leaseExpiresAt: string, at: string): Promise<WorkflowRunRecord | undefined> {
    const store = this.store as WorkflowRunStore & {
      renewWorkflowJobLease?: (identity: WorkflowRunIdentity, jobId: string, attemptId: string, leaseExpiresAt: string, at: string) => Promise<WorkflowRunRecord | undefined>;
    };
    if (!store.renewWorkflowJobLease) return undefined;
    const run = await store.renewWorkflowJobLease(identity, jobId, attemptId, leaseExpiresAt, at);
    if (run) await this.sync(run, "workflow.job.lease_renewed", { jobId, attemptId }, jobId);
    return run;
  }

  async markExpiredWorkflowJobClaimsNeedsAttention(at: string): Promise<WorkflowRunRecord[]> {
    const store = this.store as WorkflowRunStore & {
      markExpiredWorkflowJobClaimsNeedsAttention?: (at: string) => Promise<WorkflowRunRecord[]>;
    };
    if (!store.markExpiredWorkflowJobClaimsNeedsAttention) return [];
    const runs = await store.markExpiredWorkflowJobClaimsNeedsAttention(at);
    for (const run of runs) await this.sync(run, "workflow.job.needs_attention");
    return runs;
  }

  findRunningInGroup(repository: RepositoryScope, group: string): Promise<readonly WorkflowRunRecord[]> {
    return this.store.findRunningInGroup(repository, group);
  }

  async retryWorkflowJobs(identity: WorkflowRunIdentity, jobIds: readonly string[] | undefined, at: string): Promise<WorkflowRunRecord | undefined> {
    const run = await this.store.retryWorkflowJobs(identity, jobIds, at);
    if (run) await this.sync(run, "workflow.retried", { jobIds: jobIds ? [...jobIds] : undefined });
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
    if (run) await this.sync(run, "workflow.job.updated", { jobId, status: transition.status }, jobId);
    return run;
  }

  async finishWorkflowRun(identity: WorkflowRunIdentity, status: "succeeded" | "failed", completedAt: string): Promise<WorkflowRunRecord | undefined> {
    const run = await this.store.finishWorkflowRun(identity, status, completedAt);
    if (run) await this.sync(run, "workflow.finished", { status });
    return run;
  }

  async markWorkflowJobNeedsAttention(identity: WorkflowRunIdentity, jobId: string, attemptId: string, at: string, message: string): Promise<WorkflowRunRecord | undefined> {
    const store = this.store as WorkflowRunStore & {
      markWorkflowJobNeedsAttention?: (identity: WorkflowRunIdentity, jobId: string, attemptId: string, at: string, message: string) => Promise<WorkflowRunRecord | undefined>;
    };
    if (!store.markWorkflowJobNeedsAttention) throw new Error("Workflow store does not support uncertain-attempt recovery.");
    const run = await store.markWorkflowJobNeedsAttention(identity, jobId, attemptId, at, message);
    if (run) await this.sync(run, "workflow.job.needs_attention", { jobId, attemptId, message }, jobId);
    return run;
  }

  async listWorkflowRuns(repository: RepositoryScope): Promise<readonly WorkflowRunRecord[]> {
    const runs = await this.store.listWorkflowRuns(repository);
    await this.drainOutbox();
    const outbox = this.store as WorkflowRunStore & Partial<ProjectionOutboxStore>;
    // A ledger with an outbox has already queued every mutation. Re-importing
    // here only duplicates index work and can hide a failed projection behind
    // a later best-effort bulk sync.
    if (outbox.pendingProjections && outbox.acknowledgeProjection) return runs;
    try { this.registry.importRuns(runs, { repository: this.repository }); }
    catch (error) { for (const run of runs) this.onIndexError?.(error, run); }
    return runs;
  }

  private async sync(run: WorkflowRunRecord, type: string, data?: Record<string, unknown>, jobId?: string): Promise<void> {
    const outbox = this.store as WorkflowRunStore & Partial<ProjectionOutboxStore>;
    if (outbox.enqueueProjection && outbox.pendingProjections && outbox.acknowledgeProjection) {
      // The source ledger inserted the snapshot in the same transaction as its state.
      await this.drainOutbox();
      return;
    }
    try {
      this.registry.syncRun(run, { repository: this.repository });
      this.registry.appendEvent(run.id, type, run.updatedAt, data, jobId);
    } catch (error) {
      // Never turn a successful ledger transition into a failed dispatch
      // merely because the rebuildable global read model is unavailable.
      this.onIndexError?.(error, run);
    }
  }

  private async drainOutbox(): Promise<void> {
    const outbox = this.store as WorkflowRunStore & Partial<ProjectionOutboxStore>;
    if (!outbox.pendingProjections || !outbox.acknowledgeProjection) return;
    for (const event of await outbox.pendingProjections()) {
      if (event.topic !== "workflow.snapshot") continue;
      const payload = event.payload as { run?: WorkflowRunRecord; type?: string; data?: Record<string, unknown>; jobId?: string };
      if (!payload.run) continue;
      try {
        this.registry.syncRun(payload.run, { repository: this.repository });
        this.registry.appendProjectedEvent(JSON.stringify([payload.run.id, payload.run.revision ?? event.id]), payload.run.id,
          payload.type ?? "workflow.snapshot", payload.run.updatedAt, payload.data, payload.jobId);
        await outbox.acknowledgeProjection(event.id, new Date().toISOString());
      } catch (error) { this.onIndexError?.(error, payload.run); break; }
    }
  }
}
