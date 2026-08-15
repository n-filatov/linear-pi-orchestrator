import { execa } from "execa";
import type { RunRecord, Workspace } from "../domain/index.js";
import { renderTemplate, templateValues } from "../agents/templates.js";

const fallbackBases = ["origin/main", "origin/master", "main", "master"];

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

export function workspace(run: RunRecord, path: string, branch: string, provider: string): Workspace {
  return { path, branch, metadata: { repository: run.identity.repository.root, provider } };
}
