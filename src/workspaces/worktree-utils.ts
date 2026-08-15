import path from "node:path";
import { execa } from "execa";
import type { RunRecord, Workspace } from "../domain/index.js";
import { renderTemplate, templateValues } from "../agents/templates.js";

const fallbackBases = ["origin/main", "origin/master", "main", "master"];

type RelayWorkspaceOwnership = {
  createdWorkspace: boolean;
  createdBranch: boolean;
  worktreeRoot: string;
};

const ownershipKey = "taskRelay";

export function triggerString(run: RunRecord, key: string): string | undefined {
  const value = run.trigger.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function branchForRun(run: RunRecord, defaultTemplate = "feat/{{key}}-{{slug}}", workspace?: Workspace): string {
  const template = triggerString(run, "branchTemplate") ?? defaultTemplate;
  const rendered = renderTemplate(template, templateValues({
    workItem: run.item,
    workspace: workspace ?? { path: run.identity.repository.root },
    repository: run.identity.repository.root,
    model: run.agent.model,
  }));
  const branch = rendered.replace(/^\/+|\/+$/g, "");
  if (!branch || branch.includes("..") || /[~^:?*\\[\s]/.test(branch)) throw new Error(`Invalid branch rendered from template: ${rendered}`);
  return branch;
}

export async function resolveBaseBranch(repository: string, requested?: string): Promise<string> {
  const remoteHead = await execa("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repository, reject: false })
    .then((result) => result.exitCode === 0 ? result.stdout.trim() : "");
  const candidates = [...new Set([requested, remoteHead, ...fallbackBases].filter((value): value is string => Boolean(value)))];
  for (const candidate of candidates) {
    const checked = await execa("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd: repository, reject: false });
    if (checked.exitCode === 0) return candidate;
  }
  throw new Error(`Could not resolve base branch. Tried: ${candidates.join(", ")}`);
}

export async function localBranchExists(repository: string, branch: string): Promise<boolean> {
  const result = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repository, reject: false });
  return result.exitCode === 0;
}

export function workspace(
  run: RunRecord,
  workspacePath: string,
  branch: string,
  provider: string,
  ownership: RelayWorkspaceOwnership,
): Workspace {
  return {
    path: workspacePath,
    branch,
    metadata: {
      repository: run.identity.repository.root,
      provider,
      [ownershipKey]: { ...ownership, worktreeRoot: path.resolve(ownership.worktreeRoot) },
    },
  };
}

/** A worktree must be a child of the configured Relay directory, never the directory itself. */
export function isWithinWorkspaceRoot(worktreePath: string, worktreeRoot: string): boolean {
  const relative = path.relative(path.resolve(worktreeRoot), path.resolve(worktreePath));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/**
 * Validates persisted provenance before issuing a destructive command. Records from
 * older Relay versions deliberately fail this check and are treated as adopted.
 */
export function cleanupOwnership(
  space: Workspace,
  run: RunRecord,
  provider: string,
  configuredWorktreeRoot: string,
): RelayWorkspaceOwnership {
  const metadata = space.metadata;
  const ownership = metadata?.[ownershipKey];
  if (!metadata || metadata.repository !== run.identity.repository.root || metadata.provider !== provider || !isOwnership(ownership)) {
    throw new Error("Refusing to remove an adopted workspace. It was not created by this Task Relay provider.");
  }

  const configuredRoot = path.resolve(configuredWorktreeRoot);
  if (path.resolve(ownership.worktreeRoot) !== configuredRoot) {
    throw new Error("Refusing to remove a workspace whose recorded Relay root differs from the configured workspace root.");
  }
  if (!ownership.createdWorkspace && !ownership.createdBranch) {
    throw new Error("Refusing to remove an adopted workspace or branch.");
  }
  if (!isWithinWorkspaceRoot(space.path, configuredRoot)) {
    throw new Error(`Refusing to remove workspace outside the configured Relay workspace root: ${space.path}`);
  }
  return ownership;
}

function isOwnership(value: unknown): value is RelayWorkspaceOwnership {
  if (value === null || typeof value !== "object") return false;
  const ownership = value as Record<string, unknown>;
  return typeof ownership.createdWorkspace === "boolean"
    && typeof ownership.createdBranch === "boolean"
    && typeof ownership.worktreeRoot === "string";
}
