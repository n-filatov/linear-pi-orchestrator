import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import pino, { type Logger } from "pino";
import pretty from "pino-pretty";

export type RelayEvent = {
  timestamp?: string;
  level?: string;
  project: string;
  trigger?: string;
  source?: string;
  task?: string;
  agent?: string;
  model?: string;
  runId?: string;
  event: string;
  error?: string;
  duration?: number;
  [key: string]: unknown;
};

export function stateDirectory(projectRoot: string): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const name = basename(resolve(projectRoot)).replace(/[^a-zA-Z0-9._-]/g, "-") || "project";
  const hash = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 12);
  return join(base, "task-relay", `${name}-${hash}`);
}

export function eventLogPath(projectRoot: string): string { return join(stateDirectory(projectRoot), "events.jsonl"); }

export function createEventLogger(projectRoot: string, level: string = "info", prettyOutput = false): Logger {
  const directory = stateDirectory(projectRoot);
  mkdirSync(directory, { recursive: true });
  const file = pino.destination({ dest: eventLogPath(projectRoot), sync: true, mkdir: true });
  const destination = prettyOutput
    // The watch table is the live progress UI. Keep the console reserved for
    // warnings and errors; the complete structured lifecycle stays in JSONL.
    ? pino.multistream([{ level, stream: file }, { level: "warn", stream: createPrettyStream() }])
    : file;
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, destination);
}

/** A pino-pretty stream for exceptional live command output. */
export function createPrettyStream() { return pretty({ colorize: Boolean(process.stdout.isTTY), singleLine: true }); }

export function logEvent(logger: Logger, event: RelayEvent): void {
  const level = event.error ? "error" : "info";
  if (level === "error") logger.error(event, event.event);
  else logger.info(event, event.event);
}

export function readEvents(projectRoot: string): RelayEvent[] {
  const path = eventLogPath(projectRoot);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return [{ ...parsed, timestamp: typeof parsed.time === "string" ? parsed.time : undefined, level: pino.levels.labels[Number(parsed.level)] || String(parsed.level || "info") } as RelayEvent];
    } catch { return []; }
  });
}
