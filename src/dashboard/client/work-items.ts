export type WorkRun = {
  id: string;
  status?: string;
  updatedAt?: string;
  startedAt?: string;
  item?: { id?: string; title?: string };
  identity?: { workflowId?: string };
  workflowId?: string;
  projectFolderId?: string;
  folderId?: string;
  projectId?: string;
  jobs?: Record<
    string,
    { status?: string; error?: string; message?: string; waitReason?: string }
  >;
};

export function isWaiting(run: WorkRun) {
  return Object.values(run.jobs ?? {}).some(
    (job) => job.status === "pending" || job.status === "waiting",
  );
}

function isActive(run: WorkRun) {
  return ["running", "started", "pending"].includes(run.status ?? "");
}

function updatedAt(run: WorkRun) {
  return Date.parse(run.updatedAt || run.startedAt || "") || 0;
}

/** Keep the daily Work list to one newest actionable run per repository/ticket. */
export function workItems(runs: WorkRun[]) {
  const grouped = new Map<string, WorkRun>();
  for (const run of runs) {
    if (run.status !== "failed" && !isWaiting(run) && !isActive(run)) continue;
    const ticket = run.item?.id || run.id;
    const project =
      run.projectFolderId || run.folderId || run.projectId || "unknown";
    const key = [project, ticket].join(":");
    const previous = grouped.get(key);
    if (!previous || updatedAt(run) > updatedAt(previous))
      grouped.set(key, run);
  }
  return [...grouped.values()].sort(
    (left, right) => updatedAt(right) - updatedAt(left),
  );
}
