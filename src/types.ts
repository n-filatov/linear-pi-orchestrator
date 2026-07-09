export type LinearAttachment = {
  id: string;
  title?: string;
  subtitle?: string;
  url?: string;
};

export type LinearIssue = {
  id: string;
  identifier?: string;
  title: string;
  description?: string;
  url?: string;
  gitBranchName?: string;
  status?: string;
  statusType?: string;
  labels?: Array<string | { name?: string; id?: string }>;
  assignee?: string | { id?: string; name?: string; email?: string; displayName?: string } | null;
  assigneeId?: string | null;
  team?: string;
  attachments?: LinearAttachment[];
};

export type WorkerPromptAttachment = LinearAttachment & {
  localPath?: string;
  contentPreview?: string;
  error?: string;
};

export type WorkerState = {
  identifier: string;
  title: string;
  branch: string;
  worktree: string;
  repoRoot?: string;
  tmuxSession: string;
  tmuxWindow: string;
  /** Stable tmux window id (e.g. @12). Window indexes can be renumbered. */
  tmuxWindowId?: string;
  /** Best-effort display index only. Never use as unverified cleanup target. */
  tmuxWindowIndex?: string;
  status: "running" | "failed";
  /** Last-known Linear workflow status name (e.g. "In Review"); display-only. */
  linearStatus?: string;
  startedAt: string;
  error?: string;
};

export type StateFile = { workers: Record<string, WorkerState> };

export type Config = {
  mcpServer: string;
  triggerLabel: string;
  runningLabel: string;
  doneLabel: string;
  blockedLabel: string;
  pollIntervalMs: number;
  tmuxSession: string;
  repoRoot: string;
  baseBranch: string;
  branchPrefix: string;
  piCommand: string;
  agent: string;
  nodeBinDir: string;
  issueLimit: number;
  requireAssigneeMe: boolean;
  watchAssignee: string;
  setInProgress: boolean;
  inProgressState: string;
};

export type AgentPreset = {
  id: string;
  label: string;
  defaultCommand: string;
  buildInvocation: (binary: string, issueId: string, quotedPromptPath: string) => string;
  /** Extra absolute locations to probe when the command is not on PATH. */
  binaryCandidates?: () => string[];
};

export type ListIssuesArgs = {
  label?: string;
  assignee?: string;
  limit?: number;
  orderBy?: string;
  includeArchived?: boolean;
};

export type SaveIssueArgs = {
  id: string;
  labels?: string[];
  state?: string;
};

export type ExtractedImage = {
  data: string;   // base64
  mimeType: string;
};

export function issueLabels(issue: LinearIssue): string[] {
  return (issue.labels || [])
    .map((label) => (typeof label === "string" ? label : label.name || label.id || ""))
    .filter(Boolean);
}

export function isIssueDoneOrCanceled(issue: LinearIssue): boolean {
  return issue.statusType === "completed"
    || issue.statusType === "canceled"
    || issue.status === "Done"
    || issue.status === "Canceled";
}
