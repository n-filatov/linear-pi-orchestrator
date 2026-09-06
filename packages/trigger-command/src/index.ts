import { execa } from "execa";
import type { DiscoverWorkOptions, SourceEvent, WorkItem, WorkSource } from "@task-relay/domain";

export interface CommandInvocation { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; }
export interface CommandSourceConfig { id: string; discover: CommandInvocation; report?: CommandInvocation; }
export interface CommandRunner { run(invocation: CommandInvocation, input: string, signal?: AbortSignal): Promise<string>; }
export class ExecaCommandRunner implements CommandRunner {
  async run(invocation: CommandInvocation, input: string, signal?: AbortSignal): Promise<string> {
    const result = await execa(invocation.command, invocation.args ?? [], { cwd: invocation.cwd, env: invocation.env, input, reject: true, cancelSignal: signal });
    return result.stdout;
  }
}
export class CommandWorkSource implements WorkSource {
  readonly id: string;
  constructor(private readonly config: CommandSourceConfig, private readonly runner: CommandRunner = new ExecaCommandRunner()) { this.id = config.id; }
  async discover(options: DiscoverWorkOptions): Promise<readonly WorkItem[]> {
    return parseCommandItems(await this.runner.run(this.config.discover, JSON.stringify({ trigger: options.trigger }), options.signal), this.id);
  }
  async report(event: SourceEvent): Promise<void> { if (this.config.report) await this.runner.run(this.config.report, JSON.stringify(event)); }
}
export function parseCommandItems(stdout: string, sourceId: string): WorkItem[] {
  let decoded: unknown;
  try { decoded = JSON.parse(stdout); } catch { throw new Error("Command source output must be valid JSON"); }
  if (!record(decoded) || !Array.isArray(decoded.items)) throw new Error('Command source output must be an object with an "items" array');
  return decoded.items.map((value, index) => parseItem(value, sourceId, index));
}
function parseItem(value: unknown, sourceId: string, index: number): WorkItem {
  if (!record(value)) throw new Error(`Command item ${index} must be an object`);
  if (value.sourceId !== sourceId) throw new Error(`Command item ${index} has an unexpected sourceId`);
  if (typeof value.id !== "string" || !value.id) throw new Error(`Command item ${index} is missing id`);
  if (typeof value.title !== "string" || !value.title) throw new Error(`Command item ${index} is missing title`);
  if (value.description !== undefined && typeof value.description !== "string") throw new Error(`Command item ${index} has invalid description`);
  if (value.url !== undefined && typeof value.url !== "string") throw new Error(`Command item ${index} has invalid url`);
  if (value.state !== undefined && !["open", "active", "terminal", "unknown"].includes(String(value.state))) throw new Error(`Command item ${index} has invalid state`);
  if (value.terminal !== undefined && typeof value.terminal !== "boolean") throw new Error(`Command item ${index} has invalid terminal`);
  if (value.metadata !== undefined && !record(value.metadata)) throw new Error(`Command item ${index} has invalid metadata`);
  return { sourceId, id: value.id, title: value.title, description: value.description as string | undefined, url: value.url as string | undefined, state: value.state as WorkItem["state"], terminal: value.terminal as boolean | undefined, metadata: value.metadata };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
