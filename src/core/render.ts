import Table from "cli-table3";
import type { WorkerState } from "../types.ts";
import { color, isInteractive } from "./logger.ts";

/** Colored glyph + label for a worker status. */
function statusCell(status: WorkerState["status"]): string {
  switch (status) {
    case "running":
      return color.green(`● ${status}`);
    case "failed":
      return color.red(`✗ ${status}`);
    default:
      return `• ${status}`;
  }
}

/**
 * Render recorded workers as a bordered table. Falls back to a plain indented
 * list when there is no interactive terminal (piped output / scripts), so the
 * box-drawing characters don't garble logs.
 */
export function renderWorkerTable(workers: WorkerState[]): string {
  if (!isInteractive) {
    return workers
      .map((w) => `${w.identifier} [${w.status}]\n  tmux: ${tmuxRef(w)}\n  branch: ${w.branch}\n  worktree: ${w.worktree}${w.error ? `\n  error: ${w.error}` : ""}`)
      .join("\n\n");
  }

  const table = new Table({
    head: ["Issue", "Status", "tmux", "Branch"].map((h) => color.bold(h)),
    style: { head: [], border: [] },
    wordWrap: true,
  });

  for (const w of workers) {
    table.push([w.identifier, statusCell(w.status), tmuxRef(w), w.branch]);
  }

  const rows = [table.toString()];
  const errored = workers.filter((w) => w.error);
  if (errored.length) {
    rows.push("");
    for (const w of errored) rows.push(color.red(`${w.identifier}: ${w.error}`));
  }
  return rows.join("\n");
}

function tmuxRef(w: WorkerState): string {
  return `${w.tmuxSession}:${w.tmuxWindowIndex || "?"}:${w.tmuxWindow}`;
}

/**
 * Render aligned key/value pairs as a summary block. Keys are right-padded and
 * dimmed on an interactive terminal; plain (and un-padded ANSI) otherwise.
 */
export function renderSummary(pairs: Array<[string, string]>): string {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs
    .map(([k, v]) => `${color.dim(`${k}:`.padEnd(width + 1))} ${v}`)
    .join("\n");
}
