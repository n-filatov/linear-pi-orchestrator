import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import pRetry from "p-retry";
import type { RelayCommandContext, RelayCommandHandlers } from "./cli/program.js";
import type { RelayActionReference, RelayConfigV2, RelayTriggerV2 } from "./config/index.js";
import type { RelayConfig as LegacyRelayConfig } from "./config/schema.js";
import { TaskRelay, type TickResult, type TriggerProvider } from "./core/index.js";
import type { RelayLogger, RepositoryScope, RunClaim, RunIdentity, RunRecord, RunStore, RunTerminalTransition, TriggerActionDefinition, TriggerDefinition, WorkSource } from "./domain/index.js";
import { builtInHarnessProfile, CommandAgentLauncher, type AgentModelProfile, type CommandAgentProfile } from "./agents/index.js";
import { builtInActionPlugins } from "./actions/index.js";
import { RelayPluginRegistry, loadRelayPlugin, type SourcePlugin } from "./plugins/index.js";
import { DirectProcessAdapter, TmuxExecutionAdapter } from "./runtime/index.js";
import { GitWorktreeProvider, WtWorkspaceProvider } from "./workspaces/index.js";
import { CommandWorkSource, LinearMcpSource, SdkMcpToolClient, isLinearTriggerSelector, type CommandInvocation, type McpTransportConfig } from "./sources/index.js";
import { RepositoryDaemon } from "./daemon.js";
import { checkRelayUpdate, updateRelay } from "./updater.js";
import { tickTable, type TickTableRow } from "./logging/tables.js";

type RuntimeComposition = {
  relay: TaskRelay;
  sources: Map<string, WorkSource>;
  triggers: TriggerDefinition[];
  launcher: CommandAgentLauncher;
  workspace: WtWorkspaceProvider | GitWorktreeProvider;
  runStore: EventingRunStore;
  plugins: RelayPluginRegistry;
};

export function createRuntimeHandlers(): RelayCommandHandlers {
  return {
    update: async (options) => {
      const result = options.check
        ? await checkRelayUpdate({ version: options.version })
        : await updateRelay({ version: options.version });
      if (options.check) {
        return result.updateAvailable
          ? `Task Relay ${result.version} is available. Run 'relay update${result.version === "latest" ? "" : ` ${result.version}`}'.`
          : `Task Relay is up to date with ${result.version}.`;
      }
      return result.updateAvailable
        ? `Task Relay update was not installed.`
        : `Task Relay is now up to date with ${result.version}. Restart any running relay daemon or watch process.`;
    },
    once: async (context, options) => {
      const runtime = await composeRuntime(context, options);
      try { await writeTickSummary(context, await runtime.relay.tick()); }
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
          await writeTickSummary(context, await runtime.relay.tick());
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
        context.write(`Trigger: ${trigger.id}\nSource: ${trigger.sourceId}\nActions: ${(trigger.actions ?? []).map((action) => `${action.id} (${action.use})`).join(", ")}\nMatches: ${items.length}`);
        for (const item of items) context.write(`  ${item.id}  ${item.title}${item.terminal ? "  [terminal]" : ""}`);
        context.write("Dry run only; no action, source, workspace, or worker changes were made.");
      } finally { await runtime.relay.stop(); }
    },
    daemon: async (context, action) => {
      const daemon = new RepositoryDaemon(context.projectRoot);
      context.write(action === "start" ? await daemon.start() : action === "stop" ? await daemon.stop() : await daemon.status());
    },
    attach: async (context, target) => {
      const candidates = (await context.store.listRuns())
        .filter((run) => run.worker && (run.id === target || run.worker.id === target || run.item.id.toLowerCase() === target.toLowerCase()))
        .filter((run) => asRecord(run.worker?.metadata?.tmux).target)
        .sort((left, right) => right.claimedAt.localeCompare(left.claimedAt));
      if (candidates.length === 0) throw new Error(`No attachable tmux worker found for '${target}'.`);
      const active = candidates.find((run) => ["claimed", "provisioning", "launching", "running"].includes(run.status));
      const run = active ?? candidates[0];
      const executor = new TmuxExecutionAdapter({ session: context.config.execution.tmuxSession || `task-relay-${context.config.project.name || path.basename(context.projectRoot)}` });
      await executor.attach(run.worker!);
    },
    cleanup: async (context, target) => {
      const candidates = (await context.store.listRuns()).filter((run) => run.id === target || run.worker?.id === target || run.item.id.toLowerCase() === target.toLowerCase());
      if (candidates.length === 0) throw new Error(`No run or worker found for '${target}'.`);
      const removable = candidates.filter((run) => run.workspace && !run.workspaceCleanedAt);
      if (removable.length === 0) throw new Error(`No removable workspace found for '${target}'.`);
      if (removable.length > 1) throw new Error(`More than one worker workspace matches '${target}'. Use the exact worker or run id from 'relay runs --json'.`);
      const run = removable[0];
      const wasActive = ["claimed", "provisioning", "launching", "running"].includes(run.status);
      const runtime = await composeRuntime(context);
      try {
        if (run.worker && (wasActive || run.worker.metadata?.interactive === true)) await runtime.launcher.stop(run.worker);
        if (run.workspace) await runtime.workspace.cleanup(run.workspace, run);
        const stopped = wasActive ? await runtime.runStore.finishActive(run.identity, run.claimedAt, { status: "stopped", completedAt: new Date().toISOString() }) : undefined;
        const cleaned = await runtime.runStore.markWorkspaceCleaned(run.identity, run.claimedAt, new Date().toISOString());
        if (!cleaned) throw new Error(`Workspace was removed, but run ${run.id} changed before cleanup state could be recorded.`);
        const source = runtime.sources.get(run.identity.sourceId);
        if (source && stopped) await source.report({ type: "stopped", sourceId: source.id, run: stopped, occurredAt: stopped.completedAt! });
        context.write(`Cleaned ${run.item.id}: ${stopped ? "worker stopped and " : ""}workspace removed.`);
      } finally { await runtime.relay.stop(); }
    },
  };
}

async function composeRuntime(context: RelayCommandContext, filters: { trigger?: string; task?: string } = {}): Promise<RuntimeComposition> {
  const repository: RepositoryScope = { id: context.config.project.name || path.basename(context.projectRoot), root: context.projectRoot };
  const plugins = await pluginRegistry(context.config, context.projectRoot);
  const triggers = context.config.triggers
    .filter((trigger) => !filters.trigger || trigger.id === filters.trigger)
    .map((trigger) => domainTrigger(context.config, trigger, repository));
  if (filters.trigger && triggers.length === 0) throw new Error(`Unknown trigger '${filters.trigger}'.`);
  for (const trigger of triggers) {
    for (const action of trigger.actions ?? []) plugins.parseActionConfig(action.use, action.config ?? {});
  }

  const sources = new Map<string, WorkSource>();
  for (const sourceId of new Set(triggers.map((trigger) => trigger.sourceId))) {
    const definition = context.config.sources[sourceId];
    if (!definition?.enabled) continue;
    let source = await createSource(sourceId, definition, context.projectRoot, repository, plugins);
    if (filters.task) source = filterSource(source, filters.task);
    if (context.config.execution.retries > 0) source = retrySource(source, context.config.execution.retries);
    sources.set(sourceId, source);
  }

  const executor = context.config.execution.adapter === "tmux"
    ? new TmuxExecutionAdapter({ session: context.config.execution.tmuxSession || `task-relay-${repository.id}` })
    : new DirectProcessAdapter();
  const launcher = new CommandAgentLauncher({ profiles: harnessProfiles(context.config), executor, windowNameTemplate: context.config.execution.tmuxWindowName });
  const workspace = context.config.workspace.adapter === "git-worktree"
    ? new GitWorktreeProvider({ baseBranch: context.config.workspace.baseBranch, branchTemplate: context.config.workspace.branchTemplate, worktreeRoot: path.resolve(context.projectRoot, context.config.workspace.directory) })
    : new WtWorkspaceProvider({ baseBranch: context.config.workspace.baseBranch, branchTemplate: context.config.workspace.branchTemplate, worktreeRoot: path.resolve(context.projectRoot, context.config.workspace.directory) });
  const eventStore = new EventingRunStore(context.store, context.logger, repository.id);
  const triggerProvider: TriggerProvider = { list: async () => triggers };
  const relay = new TaskRelay({
    triggers: triggerProvider,
    sources: sources.values(),
    runStore: eventStore,
    workspaceProvider: workspace,
    agentLauncher: launcher,
    actionPlugins: plugins,
    actionExecutions: context.store,
    logger: relayLogger(context.logger, repository.id),
  });
  return { relay, sources, triggers, launcher, workspace, runStore: eventStore, plugins };
}

function domainTrigger(config: RelayConfigV2, trigger: RelayTriggerV2, repository: RepositoryScope): TriggerDefinition {
  const branchPrefix = config.workspace.branchPrefix;
  const source = config.sources[trigger.source];
  if (source?.use === "linear" && !isLinearTriggerSelector(trigger.match)) {
    throw new Error(`Trigger '${trigger.id}' has an invalid Linear match configuration.`);
  }
  const actions = resolveActions(config, trigger.actions);
  const actionIds = new Set<string>();
  for (const action of actions) {
    if (actionIds.has(action.id)) throw new Error(`Trigger '${trigger.id}' uses action id '${action.id}' more than once. Use inline actions with unique ids.`);
    actionIds.add(action.id);
  }
  return {
    id: trigger.id,
    sourceId: trigger.source,
    repository,
    enabled: trigger.enabled,
    selector: asRecord(trigger.match),
    maxConcurrent: trigger.maxConcurrent || config.execution.maxConcurrent,
    actions,
    targets: trigger.targets,
    firePolicy: trigger.fire.policy,
    metadata: {
      baseBranch: config.workspace.baseBranch,
      branchTemplate: config.workspace.branchTemplate || `${branchPrefix}/{{key}}-{{slug}}`,
    },
  };
}

function resolveActions(config: RelayConfigV2, references: readonly RelayActionReference[]): TriggerActionDefinition[] {
  return references.map((reference, index) => {
    let resolved: TriggerActionDefinition;
    if (typeof reference === "string") {
      const definition = config.actions[reference];
      if (!definition) throw new Error(`Unknown action '${reference}'.`);
      if (!definition.enabled) throw new Error(`Action '${reference}' is disabled.`);
      resolved = { id: reference, use: definition.use, config: definition.with };
    } else {
      if (!reference.enabled) throw new Error(`Inline action '${reference.id ?? reference.use}' is disabled.`);
      resolved = { id: reference.id ?? `${index + 1}-${reference.use}`, use: reference.use, config: reference.with, continueOnError: reference.continueOnError };
    }
    if (resolved.use === "launch") {
      const launchConfig = asRecord(resolved.config);
      const harness = stringValue(launchConfig.harness);
      if (!harness) throw new Error(`Launch action '${resolved.id}' requires 'with.harness'.`);
      if (!config.harnesses[harness]) throw new Error(`Launch action '${resolved.id}' references unknown harness '${harness}'.`);
      if (launchConfig.mode === "interactive" && config.execution.adapter !== "tmux") {
        throw new Error(`Launch action '${resolved.id}' uses interactive mode, which requires execution.adapter: tmux.`);
      }
    }
    return resolved;
  });
}

export function harnessProfiles(config: RelayConfigV2): CommandAgentProfile[] {
  return Object.entries(config.harnesses).map(([id, definition]) => {
    const overrides = asRecord(definition.with);
    if (["codex", "claude", "pi", "opencode"].includes(definition.use)) {
      const base = builtInHarnessProfile(definition.use as "codex" | "claude" | "pi" | "opencode");
      return { ...base, ...overrides, id } as CommandAgentProfile;
    }
    if (definition.use === "command") return { ...overrides, id } as CommandAgentProfile;
    throw new Error(`Harness plugin '${definition.use}' is not a command harness. External harness execution is not yet supported; use 'command' with an explicit executable.`);
  });
}

/** @deprecated Compatibility helper for consumers of the v1 programmatic API. */
export function agentProfiles(config: RelayConfigV2 | LegacyRelayConfig): CommandAgentProfile[] {
  if (config.version === 2) return harnessProfiles(config);
  return Object.entries(config.agents).map(([id, agent]) => ({
    id,
    command: agent.command,
    args: agent.args,
    interactiveArgs: agent.interactiveArgs,
    environment: agent.environment,
    models: Object.entries(config.modelProfiles)
      .filter(([profileId, profile]) => (agent.models.length === 0 || agent.models.includes(profileId)) && (!agent.provider || profile.provider === agent.provider))
      .map(([profileId, profile]): AgentModelProfile => ({ id: profileId, model: profile.model, args: profile.arguments, reasoningEffort: profile.reasoningEffort })),
    defaultModel: agent.defaultModel,
    defaultModelProfile: agent.defaultModelProfile,
    defaultReasoningEffort: agent.defaultReasoningEffort,
    modelArgument: agent.modelArgument,
    reasoningEffortArgument: agent.reasoningEffortArgument,
    promptDelivery: { mode: agent.promptDelivery.mode, index: agent.promptDelivery.argumentIndex, path: agent.promptDelivery.path },
  }));
}

async function pluginRegistry(config: RelayConfigV2, projectRoot: string): Promise<RelayPluginRegistry> {
  const registry = new RelayPluginRegistry();
  for (const plugin of builtInActionPlugins()) registry.register(plugin);
  const externalUses = new Set<string>();
  for (const source of Object.values(config.sources)) if (source.use !== "linear" && source.use !== "command") externalUses.add(source.use);
  for (const action of Object.values(config.actions)) if (!registry.action(action.use)) externalUses.add(action.use);
  for (const trigger of config.triggers) for (const action of trigger.actions) if (typeof action !== "string" && !registry.action(action.use)) externalUses.add(action.use);
  for (const use of externalUses) registry.registerAs(use, await loadRelayPlugin(use, projectRoot));
  return registry;
}

async function createSource(sourceId: string, definition: RelayConfigV2["sources"][string], projectRoot: string, repository: RepositoryScope, plugins: RelayPluginRegistry): Promise<WorkSource> {
  const config = asRecord(definition.with);
  if (definition.use === "command") {
    return new CommandWorkSource({ id: sourceId, discover: invocation(requiredRecord(config.discover, `sources.${sourceId}.with.discover`), projectRoot), report: config.report ? invocation(requiredRecord(config.report, `sources.${sourceId}.with.report`), projectRoot) : undefined });
  }
  if (definition.use === "linear") {
    const mcp = requiredRecord(config.mcp, `sources.${sourceId}.with.mcp`);
    const client = await SdkMcpToolClient.connect({ clientName: "task-relay", clientVersion: "0.2.0", transport: mcpTransport(mcp, projectRoot) });
    return new LinearMcpSource({ id: sourceId, client, tools: asRecord(config.tools), reporting: asRecord(config.reporting) });
  }
  const plugin = plugins.source(definition.use);
  if (!plugin) throw new Error(`Unknown source plugin '${definition.use}'.`);
  const pluginConfig = plugins.parseSourceConfig(definition.use, definition.with);
  return pluginWorkSource(sourceId, plugin, pluginConfig, repository, plugins, definition.use);
}

function pluginWorkSource(sourceId: string, plugin: SourcePlugin, config: unknown, repository: RepositoryScope, registry: RelayPluginRegistry, use: string): WorkSource {
  return {
    id: sourceId,
    discover: async ({ trigger, signal }) => {
      const match = registry.parseSourceMatch(use, trigger.selector ?? {});
      const context = { sourceId, config, match, repository, signal };
      const items = await plugin.discover(context);
      if (!plugin.matches) return items;
      const matched = await Promise.all(items.map(async (item) => await plugin.matches!(item, match, { sourceId, config, repository, signal }) ? item : undefined));
      return matched.filter((item): item is NonNullable<typeof item> => item !== undefined);
    },
    report: (event) => plugin.report?.(event, config) ?? Promise.resolve(),
    close: () => plugin.close?.() ?? Promise.resolve(),
  };
}

function invocation(value: Record<string, unknown>, projectRoot: string): CommandInvocation {
  const command = stringValue(value.command);
  if (!command) throw new Error("Command invocation requires a command.");
  return {
    command,
    args: stringArray(value.args),
    cwd: stringValue(value.cwd) ? path.resolve(projectRoot, stringValue(value.cwd)!) : projectRoot,
    env: stringRecord(value.environment ?? value.env),
  };
}

function mcpTransport(value: Record<string, unknown>, projectRoot: string): McpTransportConfig {
  if (value.transport === "stdio") {
    const command = stringValue(value.command);
    if (!command) throw new Error("Linear stdio MCP transport requires a command.");
    return { transport: "stdio", command, args: stringArray(value.args), cwd: stringValue(value.cwd) ? path.resolve(projectRoot, stringValue(value.cwd)!) : projectRoot, env: stringRecord(value.environment ?? value.env) };
  }
  if (value.transport === "streamable-http") {
    const url = stringValue(value.url);
    if (!url) throw new Error("Linear HTTP MCP transport requires a URL.");
    const headers: Record<string, string> = {};
    for (const [header, environmentName] of Object.entries(stringRecord(value.headersFromEnvironment))) {
      const resolved = process.env[environmentName];
      if (!resolved) throw new Error(`Environment variable ${environmentName} is required for MCP header ${header}.`);
      headers[header] = resolved;
    }
    return { transport: "streamable-http", url, headers };
  }
  throw new Error("Linear MCP transport must be 'stdio' or 'streamable-http'.");
}

function filterSource(source: WorkSource, task: string): WorkSource {
  return { id: source.id, discover: async (options) => (await source.discover(options)).filter((item) => item.id.toLowerCase() === task.toLowerCase()), report: (event) => source.report(event), close: () => source.close?.() ?? Promise.resolve() };
}

function retrySource(source: WorkSource, retries: number): WorkSource {
  return { id: source.id, discover: (options) => pRetry(() => source.discover(options), { retries, signal: options.signal }), report: (event) => source.report(event), close: () => source.close?.() ?? Promise.resolve() };
}

function pollingInterval(config: RelayConfigV2, triggerId?: string): number {
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
  findRunsForItem(query: Parameters<NonNullable<RunStore["findRunsForItem"]>>[0]) { return this.store.findRunsForItem?.(query) ?? Promise.resolve([]); }
  findWorkerTargets(query: Parameters<NonNullable<RunStore["findWorkerTargets"]>>[0]) { return this.store.findWorkerTargets?.(query) ?? Promise.resolve([]); }
  async claim(claim: RunClaim): Promise<RunRecord | undefined> { const run = await this.store.claim(claim); if (run) this.write(run, "task.claimed"); return run; }
  async finishActive(identity: RunIdentity, claimedAt: string, transition: RunTerminalTransition): Promise<RunRecord | undefined> { const run = await this.store.finishActive(identity, claimedAt, transition); if (run) this.write(run, `run.${run.status}`); return run; }
  async markWorkspaceCleaned(identity: RunIdentity, claimedAt: string, cleanedAt: string): Promise<RunRecord | undefined> { const run = await this.store.markWorkspaceCleaned(identity, claimedAt, cleanedAt); if (run) this.write(run, "run.workspace.cleaned"); return run; }
  async update(run: RunRecord): Promise<void> { await this.store.update(run); this.write(run, `run.${run.status}`); }
  private write(run: RunRecord, event: string): void {
    const fields = { project: this.project, trigger: run.identity.triggerId, source: run.identity.sourceId, task: run.item.id, title: run.item.title, agent: run.agent.agentId, model: run.agent.model, runId: run.id, event, ...(run.error ? { error: run.error } : {}) };
    if (run.error) this.logger.error(fields, event); else this.logger.info(fields, event);
  }
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredRecord(value: unknown, name: string): Record<string, unknown> { const result = asRecord(value); if (!Object.keys(result).length) throw new Error(`${name} must be an object.`); return result; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function stringRecord(value: unknown): Record<string, string> { return Object.fromEntries(Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string")); }
function eventName(message: string): string { return message.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, ""); }
async function writeTickSummary(context: RelayCommandContext, result: TickResult): Promise<void> {
  const activeRuns = await context.store.listActive({ id: context.config.project.name || path.basename(context.projectRoot), root: context.projectRoot });
  const rows: TickTableRow[] = result.items.map((outcome) => ({
    ticket: outcome.item.id,
    title: outcome.item.title,
    trigger: outcome.triggerId,
    worker: outcome.workerId,
    status: outcome.status,
    detail: outcome.reason,
  }));
  const representedWorkers = new Set(rows.map((row) => row.worker).filter((worker): worker is string => Boolean(worker)));
  for (const run of activeRuns) {
    if (run.worker && representedWorkers.has(run.worker.id)) continue;
    rows.push({
      ticket: run.item.id,
      title: run.item.title,
      trigger: run.identity.triggerId,
      worker: run.worker?.id,
      status: "running",
      detail: run.status === "running" ? "Active worker." : `Worker is ${run.status}.`,
    });
  }
  context.write(`Tick: ${result.itemsDiscovered} discovered | ${result.actionsExecuted} actions | ${result.runsLaunched} workers launched | ${result.actionsFailed} action failures | ${result.skipped} skipped`);
  context.write(rows.length ? tickTable(rows) : "No matching tickets or running workers.");
}
