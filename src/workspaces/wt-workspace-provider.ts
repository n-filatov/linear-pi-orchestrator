import path from "node:path";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { execa } from "execa";
import type { RunRecord, Workspace } from "../domain/index.js";
import type { WorktreeProvider, WorkspaceProviderOptions } from "./types.js";
import { branchForRun, cleanupOwnership, isWithinWorkspaceRoot, localBranchExists, resolveBaseBranch, workspace } from "./worktree-utils.js";

type WtSwitchResult = { worktree_path?: string; worktreePath?: string; path?: string; worktree?: { path?: string } };

/** Repository-scoped workspace provider backed by the existing `wt` CLI. */
export class WtWorkspaceProvider implements WorktreeProvider {
  constructor(private readonly options: WorkspaceProviderOptions = {}) {}

  async provision(run: RunRecord, signal?: AbortSignal): Promise<Workspace> {
    const repository = run.identity.repository.root;
    const branch = branchForRun(run, this.options.branchTemplate);
    const worktreeRoot = this.worktreeRoot(repository);
    const configPath = await this.ensureRelayConfig(worktreeRoot);
    const existing = await this.findPath(repository, branch, configPath, signal);
    if (existing) return workspace(run, existing, branch, "wt", { createdWorkspace: false, createdBranch: false, worktreeRoot });
    const exists = await localBranchExists(repository, branch);
    const args = ["--config", configPath, "-C", repository, "switch", ...(exists ? [] : ["--create"]), branch];
    if (!exists) args.push("--base", await resolveBaseBranch(repository, triggerBase(run) ?? this.options.baseBranch));
    args.push("--format", "json", "-y");
    const switched = await execa("wt", args, { cwd: repository, cancelSignal: signal });
    const parsed = parseSwitchResult(switched.stdout);
    const workspacePath = parsed.worktree_path ?? parsed.worktreePath ?? parsed.path ?? parsed.worktree?.path ?? await this.findPath(repository, branch, configPath, signal);
    if (!workspacePath) throw new Error(`wt switched ${branch}, but did not report its worktree path.`);
    if (!isWithinWorkspaceRoot(workspacePath, worktreeRoot)) {
      // Do not try to remove an unexpected path: another wt configuration or a
      // concurrent user action may have adopted it. Refusing is safer than a
      // forced rollback outside the Relay-owned directory.
      throw new Error(`wt created or selected a workspace outside the configured Relay workspace root: ${workspacePath}`);
    }
    return workspace(run, workspacePath, branch, "wt", { createdWorkspace: true, createdBranch: !exists, worktreeRoot });
  }

  async cleanup(space: Workspace, run: RunRecord): Promise<void> {
    const repository = run.identity.repository.root;
    const branch = space.branch;
    if (!branch) throw new Error("Cannot clean a workspace without a branch.");
    const worktreeRoot = this.worktreeRoot(repository);
    const ownership = cleanupOwnership(space, run, "wt", worktreeRoot);
    if (!ownership.createdWorkspace) return;
    if (ownership.createdBranch) {
      const configPath = await this.ensureRelayConfig(worktreeRoot);
      const removed = await execa("wt", ["--config", configPath, "-C", repository, "remove", branch, "--force", "-D", "--foreground", "-y", "--no-hooks"], { reject: false });
      if (removed.exitCode === 0 && !await pathExists(space.path)) return;
    }
    // wt may not know a stale worktree; native Git provides a safe recovery path.
    const removed = await execa("git", ["worktree", "remove", "--force", space.path], { cwd: repository, reject: false });
    if (removed.exitCode !== 0 && await pathExists(space.path)) {
      throw new Error(`Could not remove worktree ${space.path}: ${removed.stderr.trim() || `git exited with code ${removed.exitCode}`}`);
    }
    if (await pathExists(space.path)) throw new Error(`Git reported success, but worktree still exists at ${space.path}.`);
    if (!ownership.createdBranch) return;
    if (await localBranchExists(repository, branch)) await execa("git", ["branch", "-D", branch], { cwd: repository });
  }

  private worktreeRoot(repository: string): string {
    return path.resolve(this.options.worktreeRoot ?? path.join(repository, ".task-relay", "workspaces"));
  }

  private async findPath(repository: string, branch: string, configPath: string, signal?: AbortSignal): Promise<string | undefined> {
    const listed = await execa("wt", ["--config", configPath, "-C", repository, "list", "--format", "json"], { cwd: repository, cancelSignal: signal });
    const entries: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(entries)) return undefined;
    const match = entries.find((entry) => {
      const record = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : {};
      return record.branch === branch;
    }) as Record<string, unknown> | undefined;
    return typeof match?.path === "string" ? match.path : undefined;
  }

  private async ensureRelayConfig(worktreeRoot: string): Promise<string> {
    await mkdir(worktreeRoot, { recursive: true });
    const configPath = path.join(worktreeRoot, ".task-relay-worktrunk.toml");
    // Worktrunk treats --config as the user-level configuration while still
    // loading repository project configuration, so project hooks remain active.
    const template = path.join(worktreeRoot, "{{ branch | sanitize }}");
    await writeFile(configPath, `# Managed by Task Relay; do not edit.\nworktree-path = ${JSON.stringify(template)}\n`, "utf8");
    return configPath;
  }
}

async function pathExists(value: string): Promise<boolean> {
  try { await lstat(value); return true; }
  catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return false;
    throw error;
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
