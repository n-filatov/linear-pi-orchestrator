/**
 * Repairs the one dependency shape emitted by older dashboard versions for
 * the modular Codex/tmux actions.  This deliberately does not drop arbitrary
 * unknown dependencies: those remain validation errors.
 */
export function normalizeDashboardWorkflowConfig(input: unknown): unknown {
  if (!isRecord(input) || input.version !== 2 || !isRecord(input.workflows)) return input;

  let changed = false;
  const workflows: Record<string, unknown> = { ...input.workflows };
  for (const [workflowId, workflowValue] of Object.entries(input.workflows)) {
    if (!isRecord(workflowValue) || !isRecord(workflowValue.jobs)) continue;
    let jobsChanged = false;
    const jobs: Record<string, unknown> = { ...workflowValue.jobs };
    for (const [jobId, jobValue] of Object.entries(workflowValue.jobs)) {
      const normalized = normalizeCodexJob(jobValue);
      if (normalized !== jobValue) { jobs[jobId] = normalized; jobsChanged = true; }
    }
    if (jobsChanged) { workflows[workflowId] = { ...workflowValue, jobs }; changed = true; }
  }
  return changed ? { ...input, workflows } : input;
}

function normalizeCodexJob(value: unknown): unknown {
  if (!isRecord(value) || (value.use !== "codex.start-session" && value.uses !== "codex.start-session")) return value;
  if (!isRecord(value.with) || !isRecord(value.with.tmux) || typeof value.with.tmux.action !== "string" || !value.with.tmux.action) return value;

  const selected = value.with.tmux.action;
  const canonical = `${selected}.started`;
  const rawNeeds = value.needs === undefined ? [] : Array.isArray(value.needs) ? value.needs : [value.needs];
  const needs = rawNeeds.filter((need) => {
    const target = needTarget(need);
    return target !== "tmux" && target !== selected;
  });
  needs.push(canonical);
  const nextNeeds = Array.isArray(value.needs) ? needs : needs.length === 1 ? needs[0] : needs;
  if (sameValue(value.needs, nextNeeds)) return value;
  return { ...value, needs: nextNeeds };
}

function needTarget(need: unknown): string | undefined {
  if (isRecord(need)) return typeof need.job === "string" ? need.job : undefined;
  if (typeof need !== "string") return undefined;
  if (need === "tmux" || need.startsWith("tmux.")) return "tmux";
  if (need.includes(".")) return need.slice(0, need.indexOf("."));
  return need;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
