import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import pRetry from "p-retry";
import type { RelayCommandContext, RelayCommandHandlers } from "./cli/program.js";
import type { RelayConfig, RelayTrigger } from "./config/schema.js";
import { TaskRelay, type TickResult, type TriggerProvider } from "./core/index.js";
import type { RelayLogger, RepositoryScope, RunClaim, RunIdentity, RunRecord, RunStore, TriggerDefinition, WorkSource } from "./domain/index.js";
import { CommandAgentLauncher, type CommandAgentProfile, type AgentModelProfile } from "./agents/index.js";
import { DirectProcessAdapter, TmuxExecutionAdapter } from "./runtime/index.js";
import { GitWorktreeProvider, WtWorkspaceProvider } from "./workspaces/index.js";
import { CommandWorkSource, LinearMcpSource, SdkMcpToolClient, type CommandInvocation, type McpTransportConfig } from "./sources/index.js";
import { RepositoryDaemon } from "./daemon.js";

type RuntimeComposition = { relay: TaskRelay; sources: Map<string, WorkSource>; triggers: TriggerDefinition[]; launcher: CommandAgentLauncher; workspace: WtWorkspaceProvider | GitWorktreeProvider; runStore: EventingRunStore };

export function createRuntimeHandlers(): RelayCommandHandlers {
  return {
    once: async (context, options) => {
      const runtime = await composeRuntime(context, options);
      try { writeTickSummary(context, await runtime.relay.tick()); }
      finally { await runtime.relay.stop(); }
    },
    watch: async (context, options) => {
      const runtime = await composeRuntime(context, options);
      const interval = pollingInterval(context.config, options.trigger);
      let stopping = false;
      const stop = () => { stopping = true; };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      context.write(`Watching ${context.config.project.name || context.projectRoot} every ${interval}ms. Press Ctrl-C to stop.`);
      try {
        while (!stopping) {
          writeTickSummary(context, await runtime.relay.tick());
          if (!stopping) await delay(interval);
        }
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await runtime.relay.stop();
      }
    },
    triggerTest: async (context, selected) => {
      const runtime = await composeRuntime(context, { trigger: selected.id });
      try {
        const trigger = runtime.triggers[0];
        const source = trigger && runtime.sources.get(trigger.sourceId);
        if (!trigger || !source) throw new Error(`Trigger ${selected.id} could not be composed.`);
        const items = await source.discover({ trigger });
        context.write(`Trigger: ${trigger.id}\nSource: ${trigger.sourceId}\nAgent: ${trigger.agent?.id || "default"}\nModel: ${trigger.agent?.model || "agent default"}\nMatches: ${items.length}`);
        for (const item of items) context.write(`  ${item.id}  ${item.title}`);
        context.write("Dry run only; no source, workspace, or worker changes were made.");
      } finally { await runtime.relay.stop(); }
    },
    daemon: async (context, action) => {
      const daemon = new RepositoryDaemon(context.projectRoot);
      context.write(action === "start" ? await daemon.start() : action === "stop" ? await daemon.stop() : await daemon.status());
    },
    cleanup: async (context, target) => {
      const candidates = (await context.store.listRuns()).filter((run) => run.id === target || run.item.id.toLowerCase() === target.toLowerCase());
      if (candidates.length === 0) throw new Error(`No run found for '${target}'.`);
      const active = candidates.filter((run) => ["claimed", "provisioning", "launching", "running"].includes(run.status));
      if (active.length === 0) throw new Error(`No active run found for '${target}'.`);
      if (active.length > 1) throw new Error(`More than one active run matches '${target}'. Use the exact run id from 'relay runs --json'.`);
      const run = active[0];
      const runtime = await composeRuntime(context, { trigger: run.identity.triggerId });
      try {
        if (run.worker) await runtime.launcher.stop(run.worker);
        if (run.workspace) await runtime.workspace.cleanup(run.workspace, run);
        run.status = "stopped";
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        await runtime.runStore.update(run);
        const source = runtime.sources.get(run.identity.sourceId);
        if (source) await source.report({ type: "stopped", sourceId: source.id, run, occurredAt: run.completedAt });
        context.write(`Cleaned ${run.item.id}: worker stopped and workspace removed.`);
      } finally { await runtime.relay.stop(); }
    },
  };
}

async function composeRuntime(context: RelayCommandContext, filters: { trigger?: string; task?: string } = {}): Promise<RuntimeComposition> {
  const repository: RepositoryScope = { id: context.config.project.name || path.basename(context.projectRoot), root: context.projectRoot };
  const triggers = context.config.triggers
    .filter((trigger) => !filters.trigger || trigger.id === filters.trigger)
    .map((trigger) => domainTrigger(context.config, trigger, repository));
  if (filters.trigger && triggers.length === 0) throw new Error(`Unknown trigger '${filters.trigger}'.`);

  const sources = new Map<string, WorkSource>();
  for (const sourceId of new Set(triggers.map((trigger) => trigger.sourceId))) {
    const sourceConfig = context.config.sources[sourceId];
    if (!sourceConfig?.enabled) continue;
    let source = await createSource(sourceId, sourceConfig, context.projectRoot);
    if (filters.task) source = filterSource(source, filters.task);
    if (context.config.execution.retries > 0) source = retrySource(source, context.config.execution.retries);
    sources.set(sourceId, source);
  }

  const executor = context.config.execution.adapter === "tmux"
    ? new TmuxExecutionAdapter({ session: context.config.execution.tmuxSession || `task-relay-${repository.id}` })
    : new DirectProcessAdapter();
  const launcher = new CommandAgentLauncher({ profiles: agentProfiles(context.config), executor });
  const workspace = context.config.workspace.adapter === "git-worktree"
    ? new GitWorktreeProvider({ baseBranch: context.config.workspace.baseBranch, branchTemplate: context.config.workspace.branchTemplate, worktreeRoot: path.resolve(context.projectRoot, context.config.workspace.directory) })
    : new WtWorkspaceProvider({ baseBranch: context.config.workspace.baseBranch, branchTemplate: context.config.workspace.branchTemplate });
  const eventStore = new EventingRunStore(context.store, context.logger, repository.id);
  const triggerProvider: TriggerProvider = { list: async () => triggers };
  const relay = new TaskRelay({ triggers: triggerProvider, sources: sources.values(), runStore: eventStore, workspaceProvider: workspace, agentLauncher: launcher, logger: relayLogger(context.logger, repository.id) });
  return { relay, sources, triggers, launcher, workspace, runStore: eventStore };
}

function domainTrigger(config: RelayConfig, trigger: RelayTrigger, repository: RepositoryScope): TriggerDefinition {
  const model = trigger.model ? config.modelProfiles[trigger.model] : undefined;
  const branchPrefix = trigger.workspace?.branchPrefix || config.workspace.branchPrefix;
  return {
    id: trigger.id,
    sourceId: trigger.source,
    repository,
    enabled: trigger.enabled,
    selector: { ...trigger.match, label: trigger.label, ...(trigger.assignee ? { assignee: trigger.assignee } : {}) },
    maxConcurrent: trigger.maxConcurrent || config.execution.maxConcurrent,
    agent: { id: trigger.agent, model: trigger.model, promptTemplate: trigger.promptTemplate, metadata: { modelProfile: trigger.model, reasoningEffort: model?.reasoningEffort } },
    metadata: {
      baseBranch: trigger.workspace?.baseBranch || config.workspace.baseBranch,
      branchTemplate: trigger.workspace?.branchTemplate || config.workspace.branchTemplate || `${branchPrefix}/{{key}}-{{slug}}`,
    },
  };
}

function agentProfiles(config: RelayConfig): CommandAgentProfile[] {
  const models: AgentModelProfile[] = Object.entries(config.modelProfiles).map(([id, profile]) => ({ id, model: profile.model, args: profile.arguments, reasoningEffort: profile.reasoningEffort }));
  return Object.entries(config.agents).map(([id, agent]) => ({
    id,
    command: agent.command,
    args: agent.args,
    environment: agent.environment,
    models,
    defaultModel: agent.defaultModel,
    defaultModelProfile: agent.defaultModelProfile,
    defaultReasoningEffort: agent.defaultReasoningEffort,
    modelArgument: agent.modelArgument,
    reasoningEffortArgument: agent.reasoningEffortArgument,
    promptDelivery: { mode: agent.promptDelivery.mode, index: agent.promptDelivery.argumentIndex, path: agent.promptDelivery.path },
  }));
}

async function createSource(sourceId: string, source: RelayConfig["sources"][string], projectRoot: string): Promise<WorkSource> {
  if (source.type === "command") {
    return new CommandWorkSource({ id: sourceId, discover: invocation(source.discover, projectRoot), report: source.report ? invocation(source.report, projectRoot) : undefined });
  }
  if (!source.mcp) throw new Error(`Linear source '${sourceId}' has no MCP transport. Add sources.${sourceId}.mcp or use a command source.`);
  const client = await SdkMcpToolClient.connect({ clientName: "task-relay", clientVersion: "0.1.0", transport: mcpTransport(source.mcp, projectRoot) });
  return new LinearMcpSource({ id: sourceId, client, tools: source.tools, reporting: source.reporting });
}

function invocation(value: { command: string; args: string[]; cwd?: string; environment: Record<string, string> }, projectRoot: string): CommandInvocation {
  return { command: value.command, args: value.args, cwd: value.cwd ? path.resolve(projectRoot, value.cwd) : projectRoot, env: value.environment };
}

function mcpTransport(value: NonNullable<Extract<RelayConfig["sources"][string], { type: "linear" }>["mcp"]>, projectRoot: string): McpTransportConfig {
  if (value.transport === "stdio") return { transport: "stdio", command: value.command, args: value.args, cwd: value.cwd ? path.resolve(projectRoot, value.cwd) : projectRoot, env: value.environment };
  const headers: Record<string, string> = {};
  for (const [header, environmentName] of Object.entries(value.headersFromEnvironment)) {
    const resolved = process.env[environmentName];
    if (!resolved) throw new Error(`Environment variable ${environmentName} is required for MCP header ${header}.`);
    headers[header] = resolved;
  }
  return { transport: "streamable-http", url: value.url, headers };
}

function filterSource(source: WorkSource, task: string): WorkSource {
  return { id: source.id, discover: async (options) => (await source.discover(options)).filter((item) => item.id.toLowerCase() === task.toLowerCase()), report: (event) => source.report(event), close: () => source.close?.() ?? Promise.resolve() };
}

function retrySource(source: WorkSource, retries: number): WorkSource {
  return {
    id: source.id,
    discover: (options) => pRetry(() => source.discover(options), { retries, signal: options.signal }),
    report: (event) => source.report(event),
    close: () => source.close?.() ?? Promise.resolve(),
  };
}

function pollingInterval(config: RelayConfig, triggerId?: string): number {
  const sourceIds = new Set(config.triggers.filter((trigger) => !triggerId || trigger.id === triggerId).map((trigger) => trigger.source));
  const intervals = [...sourceIds].map((id) => config.sources[id]?.pollIntervalMs).filter((value): value is number => typeof value === "number");
  return Math.min(...intervals, 30_000);
}

function relayLogger(logger: Logger, project: string): RelayLogger {
  const write = (level: "debug" | "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) => logger[level]({ project, event: eventName(message), ...context }, message);
  return { debug: (message, context) => write("debug", message, context), info: (message, context) => write("info", message, context), warn: (message, context) => write("warn", message, context), error: (message, context) => write("error", message, context) };
}

class EventingRunStore implements RunStore {
  constructor(private readonly store: RunStore, private readonly logger: Logger, private readonly project: string) {}
  findActive(identity: RunIdentity) { return this.store.findActive(identity); }
  countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">) { return this.store.countActive(identity); }
  listActive(repository: RepositoryScope) { return this.store.listActive?.(repository) ?? Promise.resolve([]); }
  async claim(claim: RunClaim): Promise<RunRecord | undefined> { const run = await this.store.claim(claim); if (run) this.write(run, "task.claimed"); return run; }
  async update(run: RunRecord): Promise<void> { await this.store.update(run); this.write(run, `run.${run.status}`); }
  private write(run: RunRecord, event: string): void {
    const fields = { project: this.project, trigger: run.identity.triggerId, source: run.identity.sourceId, task: run.item.id, agent: run.agent.agentId, model: run.agent.model, runId: run.id, event, ...(run.error ? { error: run.error } : {}) };
    if (run.error) this.logger.error(fields, event); else this.logger.info(fields, event);
  }
}

function eventName(message: string): string { return message.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, ""); }
function writeTickSummary(context: RelayCommandContext, result: TickResult): void { context.write(`Tick complete: ${result.runsLaunched} launched, ${result.runsClaimed} claimed, ${result.skipped} skipped, ${result.itemsDiscovered} discovered.`); }
