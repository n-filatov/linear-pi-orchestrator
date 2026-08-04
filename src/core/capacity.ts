import type { Config, StateFile } from "../types.ts";

export type CapacityCheck = {
  ok: boolean;
  reason?: string;
  details: string;
};

/**
 * Workers currently occupying a slot. Counts `status: "running"` only — `failed`
 * workers hold a tmux window until cleanup, but they are not doing work and must
 * not consume capacity, or a few failures would wedge the watcher permanently.
 *
 * Callers must pass freshly read state: a tick reconciles `running` against real
 * tmux windows (cleanup + restoreLostSessions) before it starts anything, so the
 * count is only trustworthy after that has happened.
 */
export function countRunningWorkers(state: StateFile): number {
  return Object.values(state.workers).filter((worker) => worker.status === "running").length;
}

/**
 * The one capacity rule: how many workers may run at once.
 *
 * Replaces the previous free-memory/load-average thresholds. Those measured the
 * wrong thing at the wrong moment — a worker reads a few hundred MB for its first
 * minute and only later balloons into a test run, so several could clear a memory
 * floor in the same tick and collectively swamp the machine. A counted cap is
 * deterministic: the limit is the limit, whatever the workers happen to be doing.
 *
 * `maxWorkers <= 0` means unlimited.
 */
export function checkWorkerCapacity(config: Config, state: StateFile): CapacityCheck {
  const running = countRunningWorkers(state);
  const max = config.maxWorkers;
  const details = `${running} running, max ${max > 0 ? max : "unlimited"}`;

  if (max > 0 && running >= max) {
    return { ok: false, reason: `${running} worker(s) already running, max is ${max}`, details };
  }
  return { ok: true, details };
}
