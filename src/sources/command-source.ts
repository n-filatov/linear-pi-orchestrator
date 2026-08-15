import { execa } from "execa";

import type {
  DiscoverWorkOptions,
  SourceEvent,
  WorkItem,
  WorkSource,
} from "../domain/index.js";

export interface CommandInvocation {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandSourceConfig {
  id: string;
  discover: CommandInvocation;
  /** When configured, receives a canonical SourceEvent JSON document on stdin. */
  report?: CommandInvocation;
}

export interface CommandRunner {
  run(invocation: CommandInvocation, input: string, signal?: AbortSignal): Promise<string>;
}

export class ExecaCommandRunner implements CommandRunner {
  public async run(invocation: CommandInvocation, input: string, signal?: AbortSignal): Promise<string> {
    const result = await execa(invocation.command, invocation.args ?? [], {
      cwd: invocation.cwd,
      env: invocation.env,
      input,
      reject: true,
      cancelSignal: signal,
    });
    return result.stdout;
  }
}

/** Executes a no-shell command that implements the canonical JSON source protocol. */
export class CommandWorkSource implements WorkSource {
  public readonly id: string;

  public constructor(
    private readonly config: CommandSourceConfig,
    private readonly runner: CommandRunner = new ExecaCommandRunner(),
  ) {
    this.id = config.id;
  }

  public async discover(options: DiscoverWorkOptions): Promise<readonly WorkItem[]> {
    const stdout = await this.runner.run(
      this.config.discover,
      JSON.stringify({ trigger: options.trigger }),
      options.signal,
    );
    return parseCommandItems(stdout, this.id);
  }

  public async report(event: SourceEvent): Promise<void> {
    if (!this.config.report) return;
    await this.runner.run(this.config.report, JSON.stringify(event));
  }
}

/** The command protocol is exactly `{ "items": [canonical WorkItem, ...] }`. */
export function parseCommandItems(stdout: string, sourceId: string): WorkItem[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("Command source output must be valid JSON");
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.items)) {
    throw new Error('Command source output must be an object with an "items" array');
  }
  return decoded.items.map((item, index) => parseWorkItem(item, sourceId, index));
}

function parseWorkItem(value: unknown, sourceId: string, index: number): WorkItem {
  if (!isRecord(value)) throw new Error(`Command item ${index} must be an object`);
  if (value.sourceId !== sourceId) throw new Error(`Command item ${index} has an unexpected sourceId`);
  if (typeof value.id !== "string" || value.id.length === 0) throw new Error(`Command item ${index} is missing id`);
  if (typeof value.title !== "string" || value.title.length === 0) throw new Error(`Command item ${index} is missing title`);
  if (value.description !== undefined && typeof value.description !== "string") throw new Error(`Command item ${index} has invalid description`);
  if (value.url !== undefined && typeof value.url !== "string") throw new Error(`Command item ${index} has invalid url`);
  if (value.state !== undefined && !isWorkItemState(value.state)) throw new Error(`Command item ${index} has invalid state`);
  if (value.terminal !== undefined && typeof value.terminal !== "boolean") throw new Error(`Command item ${index} has invalid terminal`);
  if (value.metadata !== undefined && !isRecord(value.metadata)) throw new Error(`Command item ${index} has invalid metadata`);
  return {
    sourceId,
    id: value.id,
    title: value.title,
    description: value.description,
    url: value.url,
    state: value.state,
    terminal: value.terminal,
    metadata: value.metadata,
  };
}

function isWorkItemState(value: unknown): value is WorkItem["state"] {
  return value === "open" || value === "active" || value === "terminal" || value === "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
