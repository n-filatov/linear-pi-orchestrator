import path from "node:path";
import { execa } from "execa";
import type { RunRecord, Workspace } from "../domain/index.js";
import type { WorktreeProvider, WorkspaceProviderOptions } from "./types.js";
import { branchForRun, localBranchExists, resolveBaseBranch, workspace } from "./worktree-utils.js";

export type GitWorktreeProviderOptions = WorkspaceProviderOptions & { worktreeRoot?: string };

/** Native Git alternative for installations that do not use the `wt` helper. */
export class GitWorktreeProvider implements WorktreeProvider {
  constructor(private readonly options: GitWorktreeProviderOptions = {}) {}

  async provision(run: RunRecord, signal?: AbortSignal): Promise<Workspace> {
    const repository = run.identity.repository.root;
    const branch = branchForRun(run, this.options.branchTemplate);
    const existing = await this.findPath(repository, branch, signal);
    if (existing) return workspace(run, existing, branch, "git-worktree");

    const destination = path.join(this.options.worktreeRoot ?? path.join(repository, ".task-relay-worktrees"), safeSegment(branch));
    const exists = await localBranchExists(repository, branch);
    const args = exists
      ? ["worktree", "add", destination, branch]
      : ["worktree", "add", "-b", branch, destination, await resolveBaseBranch(repository, triggerBase(run) ?? this.options.baseBranch)];
    await execa("git", args, { cwd: repository, cancelSignal: signal });
    return workspace(run, destination, branch, "git-worktree");
  }

  async cleanup(space: Workspace, run: RunRecord): Promise<void> {
    const repository = run.identity.repository.root;
    await execa("git", ["worktree", "remove", "--force", space.path], { cwd: repository, reject: false });
    if (space.branch && await localBranchExists(repository, space.branch)) await execa("git", ["branch", "-D", space.branch], { cwd: repository });
  }

  private async findPath(repository: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
    const listed = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repository, cancelSignal: signal });
    const lines = listed.stdout.split("\n");
    let currentPath: string | undefined;
    for (const line of lines) {
      if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
      if (line === `branch refs/heads/${branch}`) return currentPath;
    }
    return undefined;
  }
}

function safeSegment(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 100) || "worktree";
}

function triggerBase(run: RunRecord): string | undefined {
  const value = run.trigger.metadata?.baseBranch;
  return typeof value === "string" ? value : undefined;
}
