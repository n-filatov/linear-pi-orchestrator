import { execa } from "execa";
import type { RunRecord, Workspace } from "../domain/index.js";
import type { WorktreeProvider, WorkspaceProviderOptions } from "./types.js";
import { branchForRun, localBranchExists, resolveBaseBranch, workspace } from "./worktree-utils.js";

type WtSwitchResult = { worktree_path?: string; worktreePath?: string; path?: string; worktree?: { path?: string } };

/** Repository-scoped workspace provider backed by the existing `wt` CLI. */
export class WtWorkspaceProvider implements WorktreeProvider {
  constructor(private readonly options: WorkspaceProviderOptions = {}) {}

  async provision(run: RunRecord, signal?: AbortSignal): Promise<Workspace> {
    const repository = run.identity.repository.root;
    const branch = branchForRun(run, this.options.branchTemplate);
    const exists = await localBranchExists(repository, branch);
    const args = ["-C", repository, "switch", ...(exists ? [] : ["--create"]), branch];
    if (!exists) args.push("--base", await resolveBaseBranch(repository, triggerBase(run) ?? this.options.baseBranch));
    args.push("--format", "json", "-y");
    const switched = await execa("wt", args, { cwd: repository, cancelSignal: signal });
    const parsed = parseSwitchResult(switched.stdout);
    const path = parsed.worktree_path ?? parsed.worktreePath ?? parsed.path ?? parsed.worktree?.path ?? await this.findPath(repository, branch, signal);
    if (!path) throw new Error(`wt switched ${branch}, but did not report its worktree path.`);
    return workspace(run, path, branch, "wt");
  }

  async cleanup(space: Workspace, run: RunRecord): Promise<void> {
    const repository = run.identity.repository.root;
    const branch = space.branch;
    if (!branch) throw new Error("Cannot clean a workspace without a branch.");
    const removed = await execa("wt", ["-C", repository, "remove", branch, "--force", "-D", "--foreground", "-y", "--no-hooks"], { reject: false });
    if (removed.exitCode === 0) return;
    // wt may not know a stale worktree; native Git provides a safe recovery path.
    await execa("git", ["worktree", "remove", "--force", space.path], { cwd: repository, reject: false });
    if (await localBranchExists(repository, branch)) await execa("git", ["branch", "-D", branch], { cwd: repository });
  }

  private async findPath(repository: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
    const listed = await execa("wt", ["-C", repository, "list", "--format", "json"], { cwd: repository, cancelSignal: signal });
    const entries: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(entries)) return undefined;
    const match = entries.find((entry) => {
      const record = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
      return record.branch === branch;
    }) as Record<string, unknown> | undefined;
    return typeof match?.path === "string" ? match.path : undefined;
  }
}

function parseSwitchResult(stdout: string): WtSwitchResult {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return parsed !== null && typeof parsed === "object" ? parsed as WtSwitchResult : {};
  } catch {
    return {};
  }
}

function triggerBase(run: RunRecord): string | undefined {
  const value = run.trigger.metadata?.baseBranch;
  return typeof value === "string" ? value : undefined;
}
