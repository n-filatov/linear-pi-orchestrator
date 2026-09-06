import { decideJob, jobInstances } from "../workflows/reconciler.js";
import type { WorkflowDefinition, WorkflowRunRecord } from "../domain/index.js";

export function redactExecution(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactExecution);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, /password|secret|token|authorization|api.?key/i.test(key) ? "[redacted]" : redactExecution(entry),
  ]));
  return value;
}

export function inspectWorkflowRun(run: WorkflowRunRecord, fallback?: WorkflowDefinition): unknown {
  const definition = run.definition ?? fallback;
  const instances = definition ? jobInstances(definition.jobs) : undefined;
  return redactExecution({
    ...run,
    decisions: definition && Object.fromEntries(definition.jobs.map((job) => {
      const state = run.jobs[job.id];
      if (state?.needsAttention) return [job.id, { action: "hold", reason: state.message ?? "Previous attempt has an uncertain outcome; inspect before retry." }];
      if (state?.attemptId && state.status === "pending") return [job.id, { action: "hold", reason: "An attempt owns this job.", attemptId: state.attemptId }];
      if (state?.retryAt) return [job.id, { action: "hold", reason: `Deferred until ${state.retryAt}` }];
      try { return [job.id, decideJob({ job, states: run.jobs, item: run.item, known: new Set(instances!.keys()), instances })]; }
      catch (error) { return [job.id, { action: "hold", reason: String(error) }]; }
    })),
  });
}
