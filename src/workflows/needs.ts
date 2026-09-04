/** States that may be selected by a string workflow dependency. */
export const workflowNeedStatuses = ["started", "succeeded", "failed", "skipped"] as const;

export type WorkflowNeedStatus = typeof workflowNeedStatuses[number];

export type ResolvedStringWorkflowNeed = {
  job: string;
  status?: WorkflowNeedStatus;
};

export type StringWorkflowNeedResolution =
  | { ok: true; need: ResolvedStringWorkflowNeed }
  | { ok: false; kind: "unknown-job"; job: string }
  | { ok: false; kind: "unknown-status"; job: string; status: string };

/**
 * Resolves the shorthand `job.Status` without treating dots in job ids as
 * separators. An exact job id wins; otherwise the longest known `job.` prefix
 * is the target and its remaining suffix must name a dependency status.
 */
export function resolveStringWorkflowNeed(need: string, knownJobIds: Iterable<string>): StringWorkflowNeedResolution {
  const ids = [...knownJobIds];
  if (ids.includes(need)) return { ok: true, need: { job: need } };

  const target = ids
    .filter((id) => need.startsWith(`${id}.`))
    .sort((left, right) => right.length - left.length)[0];

  if (!target) {
    // Keep the established error for `missing.Started`: before dotted ids were
    // supported, the first component was understood as the job name.
    return { ok: false, kind: "unknown-job", job: need.split(".", 1)[0] };
  }

  const status = need.slice(target.length + 1);
  const normalized = status.toLowerCase();
  if (!workflowNeedStatuses.includes(normalized as WorkflowNeedStatus)) {
    return { ok: false, kind: "unknown-status", job: target, status };
  }
  return { ok: true, need: { job: target, status: normalized as WorkflowNeedStatus } };
}
