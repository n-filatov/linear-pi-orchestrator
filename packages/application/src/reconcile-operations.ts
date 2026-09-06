import { assertExplicitOutcome, type ExplicitJobOutcome, type JobAttempt } from "./execute-job.js";

export interface PersistedOperation {
  jobId: string;
  pluginUse: string;
  attempt: JobAttempt;
  /** Only JSON-object operation handles are safe to persist and rehydrate. */
  operation: unknown;
}

export interface VersionedOperationPlugin {
  reconcile?(context: { attempt: JobAttempt }, operation: Record<string, unknown>): Promise<ExplicitJobOutcome<unknown>>;
  cancel?(context: { attempt: JobAttempt }, operation: Record<string, unknown>): Promise<ExplicitJobOutcome<unknown>>;
}

export interface OperationTransition<TOutput> {
  status: "succeeded" | "skipped" | "pending" | "started" | "failed";
  output?: TOutput;
  operation?: Record<string, unknown>;
  retryAt?: string;
  error?: string;
  message?: string;
  needsAttention?: boolean;
}

export interface ReconcileOperationsPorts<TOutput> {
  listOperations(): Promise<readonly PersistedOperation[]>;
  plugin(use: string, jobId?: string): VersionedOperationPlugin | undefined;
  parseOutput(output: unknown, pluginUse?: string): TOutput;
  /** Fenced write: implementations must reject a stale attempt token. */
  transition(jobId: string, expectedAttemptId: string, transition: OperationTransition<TOutput>): Promise<boolean | void>;
  now?(): string;
}

export type ReconcileAction = "reconcile" | "cancel";
export type ReconcileResult = { jobId: string; outcome: "transitioned" | "needs-attention" | "stale" };

/**
 * Reobserves persisted external operations. It never repeats an effect after
 * a lost lease: absent reconcilers, invalid handles, validation errors, and
 * observer failures become visible `needsAttention` records instead.
 */
export class ReconcileOperations<TOutput> {
  public constructor(private readonly ports: ReconcileOperationsPorts<TOutput>) {}

  public reconcile(): Promise<readonly ReconcileResult[]> { return this.run("reconcile"); }
  public cancel(): Promise<readonly ReconcileResult[]> { return this.run("cancel"); }

  private async run(action: ReconcileAction): Promise<readonly ReconcileResult[]> {
    const results: ReconcileResult[] = [];
    for (const persisted of await this.ports.listOperations()) {
      const plugin = this.ports.plugin(persisted.pluginUse, persisted.jobId);
      const operation = objectHandle(persisted.operation);
      const observer = action === "reconcile" ? plugin?.reconcile : plugin?.cancel;
      if (!operation || !observer) {
        results.push(await this.needsAttention(persisted, `Action '${persisted.pluginUse}' cannot ${action} its saved operation.`));
        continue;
      }
      try {
        const raw = await observer({ attempt: persisted.attempt }, operation);
        const transition = this.validatedTransition(raw, persisted.pluginUse);
        const written = await this.ports.transition(persisted.jobId, persisted.attempt.attemptId, transition);
        results.push({ jobId: persisted.jobId, outcome: written === false ? "stale" : "transitioned" });
      } catch (error) {
        results.push(await this.needsAttention(persisted, `Operation ${action} failed: ${messageOf(error)}`));
      }
    }
    return results;
  }

  private validatedTransition(raw: ExplicitJobOutcome<unknown>, pluginUse: string): OperationTransition<TOutput> {
    assertExplicitOutcome(raw);
    const output = raw.output === undefined ? undefined : this.ports.parseOutput(raw.output, pluginUse);
    switch (raw.status) {
      case "succeeded": return { status: "succeeded", output, message: raw.message };
      case "skipped": return { status: "skipped", output, message: raw.message };
      case "deferred": return { status: "pending", output, retryAt: validDate(raw.retryAt), message: raw.reason };
      case "running": return { status: "started", output, operation: objectHandle(raw.operation)!, message: raw.message };
      case "failed": return { status: raw.retryAt ? "pending" : "failed", output, retryAt: raw.retryAt === undefined ? undefined : validDate(raw.retryAt), error: raw.error };
    }
  }

  private async needsAttention(persisted: PersistedOperation, message: string): Promise<ReconcileResult> {
    const written = await this.ports.transition(persisted.jobId, persisted.attempt.attemptId, {
      status: "started", needsAttention: true, message,
    });
    return { jobId: persisted.jobId, outcome: written === false ? "stale" : "needs-attention" };
  }
}

function objectHandle(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function validDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("An operation outcome requires a valid retryAt timestamp.");
  return value;
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
