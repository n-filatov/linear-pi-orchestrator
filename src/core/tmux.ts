import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerState, Config } from "../types.ts";
import { resolveAgentPreset, resolveAgentBinary, shellQuote } from "./config.ts";

const execFileAsync = promisify(execFile);

export type TmuxWindow = {
  id: string;
  index: string;
  session: string;
  name: string;
  cwd: string;
};

export async function listTmuxWindows(session: string): Promise<TmuxWindow[]> {
  const { stdout } = await execFileAsync(
    "tmux",
    ["list-windows", "-t", session, "-F", "#{window_id}\t#{window_index}\t#{session_name}\t#{window_name}\t#{pane_current_path}"],
    { maxBuffer: 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [id, index, tmuxSession, name, cwd] = line.split("\t");
    return { id, index, session: tmuxSession, name, cwd };
  });
}

export function tmuxWindowRecordMatches(
  worker: WorkerState,
  window: Partial<TmuxWindow>,
): boolean {
  if (window.session !== worker.tmuxSession) return false;
  const windowName = window.name || "";
  if (windowName !== worker.tmuxWindow && !windowName.startsWith(`${worker.tmuxWindow} `)) return false;
  const cwd = window.cwd || "";
  const expectedPaths = [worker.worktree, worker.repoRoot].filter(Boolean) as string[];
  if (!expectedPaths.length) return true;
  return expectedPaths.some((p) => cwd === p || cwd.startsWith(`${p}${path.sep}`));
}

async function tmuxWindowMatchesTarget(worker: WorkerState, target: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "tmux",
    ["display-message", "-p", "-t", target, "#{session_name}\t#{window_name}\t#{pane_current_path}"],
    { maxBuffer: 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));
  const [session, name, cwd] = stdout.trim().split("\t");
  return tmuxWindowRecordMatches(worker, { id: target, index: "", session, name, cwd });
}

export async function resolveTmuxWindowTarget(worker: WorkerState): Promise<string | undefined> {
  if (worker.tmuxWindowId && await tmuxWindowMatchesTarget(worker, worker.tmuxWindowId)) {
    return worker.tmuxWindowId;
  }
  const windows = await listTmuxWindows(worker.tmuxSession);
  const matches = windows.filter((w) => tmuxWindowRecordMatches(worker, w));
  if (matches.length === 1) return matches[0].id;

  // Fallback: verify by index + name/cwd before using to avoid hitting wrong worker
  if (worker.tmuxWindowIndex) {
    const indexed = windows.find((w) => w.index === worker.tmuxWindowIndex);
    if (indexed && tmuxWindowRecordMatches(worker, indexed)) return indexed.id;
  }
  return undefined;
}

export async function renameTmuxWindow(worker: WorkerState, newName: string): Promise<boolean> {
  const target = await resolveTmuxWindowTarget(worker);
  if (!target) return false;
  await execFileAsync("tmux", ["rename-window", "-t", target, newName]).catch(() => {});
  return true;
}

export async function killTmuxWindow(worker: WorkerState): Promise<void> {
  const target = await resolveTmuxWindowTarget(worker);
  if (!target) return;
  await execFileAsync("tmux", ["kill-window", "-t", target]);
}

export async function startTmuxWindow(
  config: Config,
  windowName: string,
  worktree: string,
  issueId: string,
  promptPath: string,
): Promise<{ id?: string; index: string }> {
  await execFileAsync("tmux", ["has-session", "-t", config.tmuxSession]).catch(async () => {
    await execFileAsync("tmux", ["new-session", "-d", "-s", config.tmuxSession, "-n", "anchor"]);
  });

  const baseIndex = Number(
    (await execFileAsync("tmux", ["show-options", "-gv", "base-index"])).stdout.trim() || "0",
  );
  const windows = (await execFileAsync("tmux", ["list-windows", "-t", config.tmuxSession, "-F", "#I"])).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number);
  let index = baseIndex;
  while (windows.includes(index)) index++;

  const preset = resolveAgentPreset(config.agent);
  const binary = resolveAgentBinary(config, preset);
  const agentInvocation = preset.buildInvocation(binary, issueId, shellQuote(promptPath));
  const shellCommand = `export PATH=${shellQuote(config.nodeBinDir)}:\$PATH; LINEAR_PI_WORKER=1 ${agentInvocation}; exec \${SHELL:-zsh} -l`;

  const { stdout } = await execFileAsync("tmux", [
    "new-window",
    "-P",
    "-F", "#{window_id}\t#{window_index}",
    "-t", `${config.tmuxSession}:${index}`,
    "-n", windowName,
    "-c", worktree,
    `bash -lc ${shellQuote(shellCommand)}`,
  ]);
  const [id, actualIndex] = stdout.trim().split("\t");
  return { id, index: actualIndex || String(index) };
}
