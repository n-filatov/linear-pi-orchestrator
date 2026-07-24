import * as fs from "node:fs";
import type { StateFile } from "../types.ts";
import { ensureConfigDir, repoScopeDir, statePath, lockPath, pidPath, readConfig } from "./config.ts";

export function readState(repoRoot = readConfig().repoRoot): StateFile {
  ensureConfigDir();
  const filePath = statePath(repoRoot);
  if (!fs.existsSync(filePath)) return { workers: {} };
  return { workers: {}, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
}

export function writeState(state: StateFile, repoRoot = readConfig().repoRoot) {
  ensureConfigDir();
  fs.mkdirSync(repoScopeDir(repoRoot), { recursive: true });
  fs.writeFileSync(statePath(repoRoot), JSON.stringify(state, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withStateLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  ensureConfigDir();
  fs.mkdirSync(repoScopeDir(repoRoot), { recursive: true });
  const filePath = lockPath(repoRoot);
  const staleAfterMs = 20 * 60 * 1000;
  const deadline = Date.now() + 5 * 60 * 1000;

  while (true) {
    try {
      fs.mkdirSync(filePath);
      fs.writeFileSync(
        `${filePath}/owner.json`,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
      );
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > staleAfterMs) {
        fs.rmSync(filePath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for state lock: ${filePath}`);
      await sleep(250);
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(filePath, { recursive: true, force: true });
  }
}

export function readDaemonPid(repoRoot = readConfig().repoRoot): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidPath(repoRoot), "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(repoRoot = readConfig().repoRoot): boolean {
  const pid = readDaemonPid(repoRoot);
  return Boolean(pid && isPidRunning(pid));
}

export function removeRepoScopeDirIfUnused(repoRoot: string): boolean {
  const state = readState(repoRoot);
  if (Object.keys(state.workers).length > 0 || isDaemonRunning(repoRoot)) return false;
  const scopedDir = repoScopeDir(repoRoot);
  if (!fs.existsSync(scopedDir)) return false;
  fs.rmSync(scopedDir, { recursive: true, force: true });
  return true;
}
