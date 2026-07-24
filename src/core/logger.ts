import { createConsola } from "consola";

/**
 * Shared console renderer for interactive CLI output.
 *
 * This is purely the *pretty* sink for a human-attended terminal. The durable,
 * greppable record still lives in `watch.log` (written by the orchestrator) and
 * the Pi extension host still renders its own widget — neither goes through here.
 *
 * Colors and fancy formatting are only emitted on a real TTY. When stdout is a
 * file (the detached daemon redirects stdout into `watch.log`) or a pipe,
 * consola falls back to plain lines, so we suppress it entirely to avoid
 * duplicating the structured file log.
 */

export type LogLevel = "info" | "warning" | "error";

/** True when we may draw to an interactive, human-attended terminal. */
export const isInteractive = Boolean(process.stdout.isTTY) && process.env.LINEAR_PI_DAEMON !== "1";

const consola = createConsola({
  // consola auto-disables color on non-TTY; this just tunes verbosity.
  level: 4,
  formatOptions: { date: false, colors: true },
});

/** Emit a user-facing command result (mirrors the old ui.notify prefixes). */
export function notify(message: string, level: LogLevel = "info") {
  switch (level) {
    case "error":
      consola.error(message);
      break;
    case "warning":
      consola.warn(message);
      break;
    default:
      consola.log(message);
  }
}

/**
 * Emit a scoped watcher log line to the interactive console. No-op when not
 * interactive so the daemon's redirected stdout / Pi host stay clean — the
 * file log and Pi widget are written separately by the orchestrator.
 */
export function logLine(scope: string, message: string, level: LogLevel = "info") {
  if (!isInteractive) return;
  const tagged = consola.withTag(scope);
  switch (level) {
    case "error":
      tagged.error(message);
      break;
    case "warning":
      tagged.warn(message);
      break;
    default:
      tagged.info(message);
  }
}

// ── Tiny TTY-gated ANSI helpers (no extra dependency) ─────────────────────────

const useColor = isInteractive;
const wrap = (open: number, close: number) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const color = {
  green: wrap(32, 39),
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  cyan: wrap(36, 39),
};
