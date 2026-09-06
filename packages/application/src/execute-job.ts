/**
 * The application-layer execution use case. The host supplies plugin lookup,
 * persistence, target selection, and logging; this module owns the ordering
 * that keeps a durable job safe: validate input, claim, execute, validate
 * output, then complete the exact attempt generation.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ExplicitJobOutcome<TOutput = unknown> =
  | { status: "succeeded"; output?: TOutput; message?: string }
  | { status: "skipped"; output?: TOutput; message?: string }
  | { status: "deferred"; retryAt: string; reason: string; output?: TOutput }
  | { status: "running"; operation: JsonObject; output?: TOutput; message?: string }
  | { status: "failed"; error: string; output?: TOutput; retryAt?: string };

export type JobAttempt = { attemptId: string; leaseExpiresAt?: string };

/** The pre-v1 action shape retained while packages migrate to explicit outcomes. */
export interface LegacyActionOutcome<TOutput = unknown> {
  status: "succeeded" | "skipped";
  output?: TOutput;
  message?: string;
}

export interface LegacyOutcomeAdapterOptions {
  /**
   * Older item actions used `skipped` to mean "try again on the next poll".
   * Callers preserving that behavior provide a deterministic retry time.
   */
  skipped?: "skipped" | { retryAt: string; reason?: string };
}

/**
 * Translate the old two-state action result exactly once, at the execution
 * boundary.  New actions keep their explicit lifecycle result untouched.
 */
export function adaptActionOutcome<TOutput>(
  value: ExplicitJobOutcome<TOutput> | LegacyActionOutcome<TOutput>,
  options: LegacyOutcomeAdapterOptions = {},
): ExplicitJobOutcome<TOutput> {
  if (!value || typeof value !== "object" || !("status" in value)) throw new Error("Action returned no outcome.");
  const outcome = value as ExplicitJobOutcome<TOutput> | LegacyActionOutcome<TOutput>;
  if (outcome.status === "skipped" && options.skipped && options.skipped !== "skipped") {
    const retryAt = validDate(options.skipped.retryAt, "A legacy deferred action");
    return { status: "deferred", retryAt, reason: options.skipped.reason ?? outcome.message ?? "Legacy action deferred." , output: outcome.output };
  }
  assertExplicitOutcome(outcome);
  return outcome;
}

export type ExecuteJobResult<TOutput, TTarget> =
  | { kind: "not_claimed" }
  | { kind: "completed"; attemptId: string; outcome: ExplicitJobOutcome<TOutput>; targets: readonly TargetJobResult<TOutput, TTarget>[] }
  | { kind: "uncertain"; attemptId: string; error: string; targets: readonly TargetJobResult<TOutput, TTarget>[] };

export interface TargetJobResult<TOutput, TTarget> {
  target: TTarget;
  outcome: ExplicitJobOutcome<TOutput>;
}

export interface ExecuteJobOperations<TInput, TOutput, TTarget = never> {
  /** Resolve and parse before taking an effect-owning claim. */
  resolveInput(): Promise<unknown> | unknown;
  parseInput(input: unknown): TInput;
  claimJob(input: TInput): Promise<JobAttempt | undefined>;
  /** Omit target operations for a normal action; provide them for worker actions. */
  listTargets?: () => Promise<readonly TTarget[]>;
  /** Allows a worker action to retain its historical empty-selection message. */
  noTargetsOutcome?: () => ExplicitJobOutcome<TOutput>;
  claimTarget?: (target: TTarget, input: TInput) => Promise<JobAttempt | undefined>;
  execute(context: { attempt: JobAttempt; target?: TTarget; targetAttempt?: JobAttempt; signal: AbortSignal }, input: TInput): Promise<ExplicitJobOutcome<unknown> | LegacyActionOutcome<unknown>>;
  /** Maps legacy two-state results and validates the action's outcome contract. */
  adaptOutcome?: (raw: ExplicitJobOutcome<unknown> | LegacyActionOutcome<unknown>) => ExplicitJobOutcome<unknown>;
  /** Parses a plugin's declared output schema before it reaches durable state. */
  parseOutput(output: unknown): TOutput;
  /** Fenced write for the job's claimed generation. */
  finishJob(attemptId: string, outcome: ExplicitJobOutcome<TOutput>, targets: readonly TargetJobResult<TOutput, TTarget>[]): Promise<void>;
  /** Optional idempotency ledger for effects performed for individual targets. */
  finishTarget?: (target: TTarget, attemptId: string, outcome: ExplicitJobOutcome<TOutput>) => Promise<void>;
  /**
   * Preserve partial target effects when a claim, heartbeat, output validation,
   * or plugin call is uncertain. A thrown plugin call is never assumed safe to
   * retry: the action may have made its external effect before it threw.
   */
  finishUncertain(attemptId: string, error: string, targets: readonly TargetJobResult<TOutput, TTarget>[]): Promise<void>;
  /**
   * Called while a plugin is executing.  The adapter renews the job and, when
   * present, its selected worker invocation using their attempt fences.
   */
  heartbeat?: (context: { attempt: JobAttempt; target?: TTarget; targetAttempt?: JobAttempt }) => Promise<void>;
  /** Defaults to 30 seconds when heartbeat is provided. */
  heartbeatIntervalMs?: number;
}

export class ExecuteJob<TInput, TOutput, TTarget = never> {
  public constructor(private readonly operations: ExecuteJobOperations<TInput, TOutput, TTarget>) {}

  public async execute(): Promise<ExecuteJobResult<TOutput, TTarget>> {
    const input = this.operations.parseInput(await this.operations.resolveInput());
    const attempt = await this.operations.claimJob(input);
    if (!attempt) return { kind: "not_claimed" };

    const workerExecution = this.operations.listTargets !== undefined;
    const targets = workerExecution ? await this.operations.listTargets!() : [undefined as never];
    if (targets.length === 0) {
      const outcome: ExplicitJobOutcome<TOutput> = this.operations.noTargetsOutcome?.() ?? { status: "skipped", message: "No matching workers." };
      await this.operations.finishJob(attempt.attemptId, outcome, []);
      return { kind: "completed", attemptId: attempt.attemptId, outcome, targets: [] };
    }

    const results: TargetJobResult<TOutput, TTarget>[] = [];
    try {
      let singleOutcome: ExplicitJobOutcome<TOutput> | undefined;
      for (const target of targets) {
        const targetAttempt = target === undefined ? undefined : await this.claimTarget(target, input);
        const context = { attempt, ...(target === undefined ? {} : { target, targetAttempt }) };
        const raw = await this.executeWithHeartbeat(context, input);
        const outcome = this.validateOutcome(raw);
        if (target !== undefined) {
          results.push({ target, outcome });
          if (targetAttempt && this.operations.finishTarget) {
            await this.operations.finishTarget(target, targetAttempt.attemptId, outcome);
          }
        } else singleOutcome = outcome;
      }
      const outcome = singleOutcome ?? selectOutcome(results.map(result => result.outcome));
      await this.operations.finishJob(attempt.attemptId, outcome, results);
      return { kind: "completed", attemptId: attempt.attemptId, outcome, targets: results };
    } catch (error) {
      const message = messageFor(error);
      await this.operations.finishUncertain(attempt.attemptId, message, results);
      return { kind: "uncertain", attemptId: attempt.attemptId, error: message, targets: results };
    }
  }

  private async claimTarget(target: TTarget, input: TInput): Promise<JobAttempt> {
    if (!this.operations.claimTarget) {
      throw new Error("Worker execution requires a target claim operation.");
    }
    const claim = await this.operations.claimTarget(target, input);
    if (!claim) throw new Error("A target action has an unresolved prior invocation.");
    return claim;
  }

  private validateOutcome(raw: ExplicitJobOutcome<unknown> | LegacyActionOutcome<unknown>): ExplicitJobOutcome<TOutput> {
    const adapted = this.operations.adaptOutcome?.(raw) ?? adaptActionOutcome(raw);
    return adapted.output === undefined
      ? adapted as ExplicitJobOutcome<TOutput>
      : { ...adapted, output: this.operations.parseOutput(adapted.output) } as ExplicitJobOutcome<TOutput>;
  }

  private async executeWithHeartbeat(
    context: { attempt: JobAttempt; target?: TTarget; targetAttempt?: JobAttempt },
    input: TInput,
  ): Promise<ExplicitJobOutcome<unknown> | LegacyActionOutcome<unknown>> {
    const heartbeat = this.operations.heartbeat;
    const controller = new AbortController();
    if (!heartbeat) return this.operations.execute({ ...context, signal: controller.signal }, input);
    const intervalMs = this.operations.heartbeatIntervalMs ?? 30_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("heartbeatIntervalMs must be a positive finite number.");
    let heartbeatFailure: unknown;
    let renewing = false;
    const renew = async (): Promise<void> => {
      if (renewing || heartbeatFailure) return;
      renewing = true;
      try { await heartbeat(context); }
      catch (error) { heartbeatFailure = error; controller.abort(error); }
      finally { renewing = false; }
    };
    const timer = setInterval(() => { void renew(); }, intervalMs);
    const unref = timer as unknown as { unref?: () => void };
    unref.unref?.();
    try {
      const result = await this.operations.execute({ ...context, signal: controller.signal }, input);
      if (heartbeatFailure) throw new AttemptLeaseLostError(messageFor(heartbeatFailure));
      return result;
    } finally {
      clearInterval(timer);
    }
  }
}

export function assertExplicitOutcome(value: unknown): asserts value is ExplicitJobOutcome<unknown> {
  if (!value || typeof value !== "object" || !("status" in value)) throw new Error("Action returned no explicit outcome.");
  const outcome = value as { status?: unknown; retryAt?: unknown; reason?: unknown; operation?: unknown; error?: unknown };
  if (!['succeeded', 'skipped', 'deferred', 'running', 'failed'].includes(String(outcome.status))) {
    throw new Error(`Action returned an invalid outcome status: ${String(outcome.status)}`);
  }
  if (outcome.status === "deferred" && (typeof outcome.retryAt !== "string" || typeof outcome.reason !== "string")) {
    throw new Error("A deferred action outcome requires retryAt and reason.");
  }
  if (outcome.status === "deferred") validDate(outcome.retryAt, "A deferred action");
  if (outcome.status === "running" && (!outcome.operation || typeof outcome.operation !== "object" || Array.isArray(outcome.operation))) {
    throw new Error("A running action outcome requires an operation handle.");
  }
  if (outcome.status === "running") assertJsonValue(outcome.operation, "A running action operation handle");
  if (outcome.status === "failed" && typeof outcome.error !== "string") {
    throw new Error("A failed action outcome requires an error message.");
  }
  if (outcome.status === "failed" && outcome.retryAt !== undefined) validDate(outcome.retryAt, "A failed action");
}

export class AttemptLeaseLostError extends Error {
  public constructor(message: string) { super(`Attempt lease renewal failed: ${message}`); this.name = "AttemptLeaseLostError"; }
}

function validDate(value: unknown, subject: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${subject} requires a valid retryAt timestamp.`);
  return value;
}

function assertJsonValue(value: unknown, subject: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (Number.isFinite(value)) return; throw new Error(`${subject} must be JSON-serializable.`); }
  if (Array.isArray(value)) { value.forEach((entry) => assertJsonValue(entry, subject, seen)); return; }
  if (!value || typeof value !== "object" || seen.has(value)) throw new Error(`${subject} must be JSON-serializable.`);
  seen.add(value); Object.values(value).forEach((entry) => assertJsonValue(entry, subject, seen)); seen.delete(value);
}

function messageFor(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function selectOutcome<TOutput>(outcomes: readonly ExplicitJobOutcome<TOutput>[]): ExplicitJobOutcome<TOutput> {
  if (outcomes.length === 0) throw new Error("ExecuteJob has no action outcome to persist.");
  return outcomes.find(outcome => outcome.status === "failed")
    ?? outcomes.find(outcome => outcome.status === "running" || outcome.status === "deferred")
    ?? outcomes.find(outcome => outcome.status === "succeeded")
    ?? outcomes[0]!;
}
