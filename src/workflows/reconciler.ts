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
  /** Declared names in the workflow, used to reject a dependency typo. */
  known: ReadonlySet<string>;
  /** Instance ids for each declared name; a matrix job has several. */
  instances?: ReadonlyMap<string, readonly string[]>;
}

const pending: WorkflowJobState = { status: "pending", attempts: 0 };

/** Every state a declared name covers: one job, or all of a matrix's instances. */
function instancesOf(
  name: string,
  states: Readonly<Record<string, WorkflowJobState>>,
  instances: ReadonlyMap<string, readonly string[]> | undefined,
): (WorkflowJobState | undefined)[] {
  const ids = instances?.get(name);
  if (!ids || ids.length === 0) return [states[name]];
  return ids.map((id) => states[id]);
}

/** The whole group is met only when every instance is; impossible if any is. */
function aggregate(results: readonly ("met" | "waiting" | "impossible")[]): "met" | "waiting" | "impossible" {
  if (results.some((result) => result === "impossible")) return "impossible";
  return results.every((result) => result === "met") ? "met" : "waiting";
}

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
    // A matrix job expands into several instances sharing one group name, so a
    // need on that name must be met by every instance, not just one.
    const instances = instancesOf(need.job, input.states, input.instances);
    const satisfaction = aggregate(instances.map((state) => needSatisfaction(need, state)));
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
    const status = expressionStatus(input.job, input.states, input.instances);
    if (!evaluateCondition(input.job.if, expressionContexts(input.item, input.job, input.states, input.instances), status)) {
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
  instances?: ReadonlyMap<string, readonly string[]>,
): Record<string, unknown> {
  const needs: Record<string, unknown> = {};
  for (const need of job.needs ?? []) {
    const covered = instancesOf(need.job, states, instances).map((state) => state ?? pending);
    // A matrix group reads as one dependency: its outputs are merged, and its
    // result is the worst of its instances.
    const merged: Record<string, unknown> = {};
    for (const state of covered) Object.assign(merged, state.outputs ?? {});
    const worst = covered.some((state) => state.status === "failed" || state.status === "omitted") ? "failure"
      : covered.every((state) => state.status === "succeeded" || state.status === "started") ? "success"
      : covered.every((state) => isTerminalJobStatus(state.status)) ? "skipped" : "";
    needs[need.job] = {
      result: covered.length === 1 ? resultOf(covered[0].status) : worst,
      status: covered.length === 1 ? covered[0].status : worst,
      outputs: merged,
    };
  }
  const jobs: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(states)) {
    jobs[id] = { result: resultOf(state.status), status: state.status, outputs: state.outputs ?? {} };
  }
  return {
    item: { id: item.id, title: item.title, description: item.description ?? "", url: item.url ?? "", state: item.state ?? "unknown", metadata: item.metadata ?? {} },
    needs,
    jobs,
    matrix: job.matrix ?? {},
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
  instances?: ReadonlyMap<string, readonly string[]>,
): ExpressionStatus {
  const dependencies = (job.needs ?? []).flatMap((need) =>
    instancesOf(need.job, states, instances).map((state) => state?.status ?? "pending"));
  const failure = dependencies.some((status) => status === "failed" || status === "omitted");
  return { success: !failure, failure, cancelled: false };
}

/** Declared name to instance ids, for a workflow whose jobs may be a matrix. */
export function jobInstances(jobs: readonly WorkflowJobDefinition[]): Map<string, string[]> {
  const instances = new Map<string, string[]>();
  for (const job of jobs) {
    const name = job.group ?? job.id;
    instances.set(name, [...(instances.get(name) ?? []), job.id]);
  }
  return instances;
}

/** A job that has run longer than its own deadline, if it declared one. */
export function jobTimedOut(job: WorkflowJobDefinition, state: WorkflowJobState | undefined, now: Date): boolean {
  if (!job.timeoutMs || !state?.startedAt) return false;
  if (isTerminalJobStatus(state.status)) return false;
  return now.getTime() - new Date(state.startedAt).getTime() >= job.timeoutMs;
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
