import type { WorkflowJobStatus } from "../domain/index.js";
import { isVersionedActionPlugin, type ActionResult, type AnyActionPlugin, type ExplicitActionOutcome } from "../plugins/index.js";

export interface JobOutcome {
  status: WorkflowJobStatus;
  result: ActionResult;
  retryAt?: string;
  operation?: Record<string, unknown>;
  error?: string;
}

/** All legacy lifecycle conventions are translated once at the application boundary. */
export function jobOutcome(plugin: AnyActionPlugin, outcome: ActionResult | ExplicitActionOutcome): JobOutcome {
  if (outcome.status === "deferred") {
    if (!Number.isFinite(Date.parse(outcome.retryAt))) throw new Error("A deferred action must return a valid retryAt timestamp.");
    return { status: "pending", retryAt: outcome.retryAt, result: { status: "skipped", message: outcome.reason, output: outcome.output } };
  }
  if (outcome.status === "failed") {
    if (outcome.retryAt && !Number.isFinite(Date.parse(outcome.retryAt))) throw new Error("An action retryAt must be a valid timestamp.");
    return { status: outcome.retryAt ? "pending" : "failed", retryAt: outcome.retryAt, error: outcome.error, result: { status: "skipped", message: outcome.error, output: outcome.output } };
  }
  if (outcome.status === "running") {
    if (!outcome.operation || typeof outcome.operation !== "object" || Array.isArray(outcome.operation)) throw new Error("A running action must return an object operation handle.");
    return { status: "started", operation: outcome.operation as Record<string, unknown>, result: { status: "succeeded", output: outcome.output, message: outcome.message } };
  }
  if (isVersionedActionPlugin(plugin)) return { status: outcome.status, result: outcome };
  if (outcome.status === "skipped") return { status: plugin.use === "cleanup" ? "skipped" : "pending", result: outcome };
  return { status: plugin.target !== "worker" && typeof outcome.output?.runId === "string" ? "started" : "succeeded", result: outcome };
}
