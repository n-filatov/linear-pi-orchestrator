import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { execa } from "execa";

/** The stable identity and local paths for a checkout. */
export interface RepositoryIdentity {
  /** Stable key suitable for indexing a global registry. */
  id: string;
  /** Normalized origin URL, or `path:<common-dir>` when no origin exists. */
  key: string;
  /** Canonical worktree root (the directory users are currently in). */
  root: string;
  /** Canonical shared Git directory, useful for worktrees and fallbacks. */
  commonDir: string;
  /** Normalized origin without credentials, when one is configured. */
  remote?: string;
}

/**
 * Converts the common Git remote spellings to one credential-free key.
 * SSH scp syntax (`git@host:org/repo.git`) is intentionally supported.
 */
export function normalizeGitRemote(value: string): string {
  let remote = value.trim();
  if (!remote) return "";
  remote = remote.replace(/\\+/g, "/");

  let host: string;
  let path: string;
  const scp = !remote.includes("://") && remote.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const parsed = new URL(remote);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      // A malformed remote is still made deterministic and credential-free.
      return remote.replace(/^[^/]+@/, "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    }
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return `${host.toLowerCase()}/${path}`;
}

async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); } catch { return absolute; }
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const result = await execa("git", args, { cwd, reject: false });
  if (result.exitCode !== 0) return undefined;
  const output = result.stdout.trim();
  return output || undefined;
}

/** Resolve repository identity from any checkout, including a linked worktree. */
export async function getRepositoryIdentity(start = process.cwd()): Promise<RepositoryIdentity> {
  const rootRaw = await git(start, ["rev-parse", "--show-toplevel"]);
  if (!rootRaw) {
    const root = await canonical(start);
    const key = `path:${root}`;
    return { id: key, key, root, commonDir: root };
  }
  const root = await canonical(rootRaw);
  const commonRaw = await git(start, ["rev-parse", "--git-common-dir"]);
  const commonDir = await canonical(commonRaw ? (isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw)) : root);
  const originRaw = await git(start, ["config", "--get", "remote.origin.url"]);
  const remote = originRaw ? normalizeGitRemote(originRaw) : undefined;
  const key = remote || `path:${commonDir}`;
  return { id: key, key, root, commonDir, ...(remote ? { remote } : {}) };
}
