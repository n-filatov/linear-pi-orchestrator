import {
  isTerminalJobStatus,
  needSatisfaction,
  type WorkflowJobDefinition,
  type WorkflowJobState,
  type WorkflowJobStatus,
  type WorkflowRunRecord,
  type WorkItem,
} from "../domain/index.js";
import { evaluateCondition, type ExpressionStatus } from "./expressions.js";

/** What the reconciler decided to do with one job on this tick. */
export type JobDecision =
  | { action: "run" }
  | { action: "hold"; reason: string }
  | { action: "settle"; status: Extract<WorkflowJobStatus, "skipped" | "omitted">; reason: string };

export interface JobDecisionInput {
  job: WorkflowJobDefinition;
  states: Readonly<Record<string, WorkflowJobState>>;
  item: WorkItem;
  /** Names of every job in the workflow, used to reject a dependency typo. */
  known: ReadonlySet<string>;
}

const pending: WorkflowJobState = { status: "pending", attempts: 0 };

/**
 * Decides one job's fate from persisted state alone.
 *
 * This is a pure function on purpose. Whether a job may run is the part of the
 * durable DAG most likely to be wrong, and keeping it free of I/O means it can
 * be tested exhaustively without a store, a source, or a tmux server.
 */
export function decideJob(input: JobDecisionInput): JobDecision {
  const state = input.states[input.job.id] ?? pending;
  if (isTerminalJobStatus(state.status)) return { action: "hold", reason: `already ${state.status}` };
  if (state.status === "started") return { action: "hold", reason: "worker is running" };

  const blocked: string[] = [];
  for (const need of input.job.needs ?? []) {
    if (!input.known.has(need.job)) {
      return { action: "settle", status: "omitted", reason: `needs unknown job '${need.job}'` };
    }
    const satisfaction = needSatisfaction(need, input.states[need.job]);
    const label = `${need.job}.${need.status ?? "Succeeded"}`;
    if (satisfaction === "impossible") {
      // Only `if:` can rescue a job whose dependency can no longer be met, and
      // only when the condition does not itself depend on success().
      if (!input.job.if) return { action: "settle", status: "omitted", reason: `${label} can no longer be satisfied` };
    } else if (satisfaction === "waiting") {
      blocked.push(label);
    }
  }
  if (blocked.length > 0) return { action: "hold", reason: `blocked on ${blocked.join(", ")}` };

  if (input.job.if) {
    const status = expressionStatus(input.job, input.states);
    if (!evaluateCondition(input.job.if, expressionContexts(input.item, input.job, input.states), status)) {
      return { action: "settle", status: "skipped", reason: `if evaluated false` };
    }
    return { action: "run" };
  }
  // GitHub's implicit default: a job without a condition needs its dependencies
  // to have succeeded. Reaching here means they did.
  return { action: "run" };
}

/**
 * The contexts an `if:` expression may read. `needs` mirrors GitHub's shape, so
 * `needs.<job>.result` and `needs.<job>.outputs.<name>` behave as expected.
 */
export function expressionContexts(
  item: WorkItem,
  job: WorkflowJobDefinition,
  states: Readonly<Record<string, WorkflowJobState>>,
): Record<string, unknown> {
  const needs: Record<string, unknown> = {};
  for (const need of job.needs ?? []) {
    const state = states[need.job] ?? pending;
    needs[need.job] = { result: resultOf(state.status), status: state.status, outputs: state.outputs ?? {} };
  }
  const jobs: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(states)) {
    jobs[id] = { result: resultOf(state.status), status: state.status, outputs: state.outputs ?? {} };
  }
  return {
    item: { id: item.id, title: item.title, url: item.url ?? "", state: item.state ?? "unknown", metadata: item.metadata ?? {} },
    needs,
    jobs,
  };
}

/** GitHub reports four job results; Relay's `started` reads as a success so far. */
export function resultOf(status: WorkflowJobStatus): string {
  switch (status) {
    case "succeeded": return "success";
    case "started": return "success";
    case "failed": return "failure";
    case "skipped": return "skipped";
    case "omitted": return "skipped";
    default: return "";
  }
}

/** success()/failure() read only the dependencies this job declared. */
export function expressionStatus(
  job: WorkflowJobDefinition,
  states: Readonly<Record<string, WorkflowJobState>>,
): ExpressionStatus {
  const dependencies = (job.needs ?? []).map((need) => states[need.job]?.status ?? "pending");
  const failure = dependencies.some((status) => status === "failed" || status === "omitted");
  return { success: !failure, failure, cancelled: false };
}

/**
 * A run is finished only when every job is terminal. A `started` job holds the
 * run open on purpose: its agent is still working, a later job may be waiting
 * for that agent to finish, and closing the run early would mean never
 * observing the outcome. An interactive worker nobody closes therefore keeps
 * its run open until the run's own deadline passes.
 */
export function runOutcome(
  jobs: readonly WorkflowJobDefinition[],
  states: Readonly<Record<string, WorkflowJobState>>,
): { done: boolean; status: "succeeded" | "failed" } {
  let done = true;
  let failed = false;
  for (const job of jobs) {
    const status = states[job.id]?.status ?? "pending";
    if (!isTerminalJobStatus(status)) done = false;
    if (status === "failed" && !job.continueOnError) failed = true;
  }
  return { done, status: failed ? "failed" : "succeeded" };
}

/** Jobs still waiting when a run's deadline passes are recorded as omitted. */
export function timedOut(run: WorkflowRunRecord, now: Date): boolean {
  return Boolean(run.timeoutAt) && now.toISOString() >= run.timeoutAt!;
}
