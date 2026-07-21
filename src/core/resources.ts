import * as os from "node:os";
import type { Config } from "../types.ts";

export type ResourceCheck = {
  ok: boolean;
  reason?: string;
  details: string;
};

/**
 * Guards against starting workers that would push the host past its memory/CPU
 * budget. Loop-based rather than hard OOM prevention: reads current free
 * memory and load average so we refuse to spawn *new* work when the machine
 * is already under pressure, rather than reacting after it crashes.
 */
export function checkResourceCapacity(config: Config): ResourceCheck {
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const freeMemMb = Math.round(freeMemBytes / (1024 * 1024));
  const freePercent = totalMemBytes > 0 ? (freeMemBytes / totalMemBytes) * 100 : 100;

  const cpuCount = os.cpus().length || 1;
  const [load1] = os.loadavg();
  const loadPerCpu = load1 / cpuCount;

  const details = `free mem ${freeMemMb}MB (${freePercent.toFixed(1)}%), load avg 1m ${load1.toFixed(2)} (${loadPerCpu.toFixed(2)}/cpu across ${cpuCount} cpus)`;

  if (!config.resourceCheckEnabled) return { ok: true, details };

  if (freeMemMb < config.minFreeMemoryMb) {
    return { ok: false, reason: `free memory ${freeMemMb}MB below minimum ${config.minFreeMemoryMb}MB`, details };
  }
  if (freePercent < config.minFreeMemoryPercent) {
    return { ok: false, reason: `free memory ${freePercent.toFixed(1)}% below minimum ${config.minFreeMemoryPercent}%`, details };
  }
  if (config.maxLoadAveragePerCpu > 0 && loadPerCpu > config.maxLoadAveragePerCpu) {
    return { ok: false, reason: `load average ${loadPerCpu.toFixed(2)}/cpu above maximum ${config.maxLoadAveragePerCpu}/cpu`, details };
  }
  return { ok: true, details };
}
