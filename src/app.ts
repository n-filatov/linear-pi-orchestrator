import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import pRetry from "p-retry";
import type { RelayCommandContext, RelayCommandHandlers } from "./cli/program.js";
import { loadRelayConfig, type RelayActionReference, type RelayConfigV2, type RelayTriggerV2, type RelayWorkflowJobV2, type RelayWorkflowV2 } from "./config/index.js";
import type { RelayConfig as LegacyRelayConfig } from "./config/schema.js";
import { TaskRelay, type TickResult, type TriggerProvider } from "./core/index.js";
import type { AgentLauncher, AgentProfile, AgentResolution, RelayLogger, RepositoryScope, RunClaim, RunIdentity, RunRecord, RunStore, RunTerminalTransition, TriggerActionDefinition, TriggerDefinition, WorkerChildHandle, WorkerCompletion, WorkerHandle, WorkerRuntime, WorkflowDefinition, WorkflowJobDefinition, WorkflowNeed, Workspace, WorkspaceProvider, WorkItem, WorkSource } from "./domain/index.js";
import { builtInHarnessProfile, CommandAgentLauncher, CompositeAgentLauncher, type AgentModelProfile, type CommandAgentProfile, type ConfiguredHarnessPlugin } from "./agents/index.js";
import { builtInActionPlugins } from "./actions/index.js";
import { BUILT_IN_HARNESS_PROFILES, BUILT_IN_SOURCES, RelayPluginRegistry, findInstalledPlugin, loadRelayPlugin, readPluginLock, type LaunchWorkerActionRequest, type SourcePlugin } from "./plugins/index.js";
import { loadReusableWorkflow } from "./config/reusable.js";
import { DirectProcessAdapter, TmuxExecutionAdapter } from "./runtime/index.js";
import { GitWorktreeProvider, WtWorkspaceProvider } from "./workspaces/index.js";
import { CommandWorkSource, LinearMcpSource, SdkMcpToolClient, isLinearTriggerSelector, type CommandInvocation, type McpTransportConfig } from "./sources/index.js";
import { RepositoryDaemon } from "./daemon.js";
import { checkRelayUpdate, updateRelay } from "./updater.js";
import { tickTable, type TickTableRow } from "./logging/tables.js";
import { createEventLogger } from "./logging/events.js";
import { decideJob } from "./workflows/reconciler.js";
import { GlobalWorkerRegistry, type GlobalWorkerRecord } from "./state/global-worker-registry.js";
import { getRepositoryIdentity } from "./state/repository-identity.js";
import { RepositoryStateStore } from "./state/store.js";

type RuntimeComposition = {
  relay: TaskRelay;
  sources: Map<string, WorkSource>;
  triggers: TriggerDefinition[];
  workflows: WorkflowDefinition[];
  /** Either the command launcher or a composite that also routes plugin harnesses. */
  launcher: AgentLauncher;
  workspace: WorkspaceProvider;
  runStore: EventingRunStore;
  plugins: RelayPluginRegistry;
};

async function ensureRegistryContext(context: RelayCommandContext): Promise<{ registry: GlobalWorkerRegistry; repository: RepositoryScope; registryRepository: RepositoryScope }> {
  const identity = context.repositoryIdentity ?? await getRepositoryIdentity(context.projectRoot);
  const repository = { id: context.config.project.name || path.basename(context.projectRoot), root: context.projectRoot };
  const registryRepository = { id: identity.id, root: identity.root };
  const registry = context.registry ?? new GlobalWorkerRegistry();
  const runs = await context.store.listRuns();
  if (runs.length > 0) registry.importRuns(runs, { repository: registryRepository });
  context.repositoryIdentity = identity;
  context.registry = registry;
  return { registry, repository, registryRepository };
}

function registryCandidates(registry: GlobalWorkerRegistry, target: string): GlobalWorkerRecord[] {
  const normalized = target.toLowerCase();
  return registry.list({ includeCleaned: true }).filter((entry) => entry.id === target
    || entry.runId === target
    || entry.snapshot.worker?.id === target
    || entry.issueKey.toLowerCase() === normalized
    || entry.itemId.toLowerCase() === normalized)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function chooseRegistryCandidate(candidates: GlobalWorkerRecord[], target: string): GlobalWorkerRecord | undefined {
  if (candidates.length === 0) return undefined;
  const scopes = new Set(candidates.map((entry) => `${entry.repository.id}\u0000${entry.sourceId}`));
  if (scopes.size > 1) throw new Error(`More than one repository or source matches '${target}'. Use the exact worker id from 'relay worker list --json'.`);
  return candidates.find((entry) => ["claimed", "provisioning", "launching", "running", "stopping"].includes(entry.status)) ?? candidates[0];
}

function addIssueToLegacyTmuxMetadata(run: RunRecord, workerId?: string): void {
  const tmux = asRecord(run.worker?.metadata?.tmux);
  if (Object.keys(tmux).length === 0) return;
  if (typeof tmux.issue !== "string") tmux.issue = run.item.id;
  if (workerId && typeof tmux.workerId !== "string") tmux.workerId = workerId;
}

function updateRegistryStatus(
  registry: GlobalWorkerRegistry,
  workerId: string,
  status: Parameters<GlobalWorkerRegistry["updateStatus"]>[1],
  options: Parameters<GlobalWorkerRegistry["updateStatus"]>[2] = {},
): void {
  const at = options.at ?? new Date().toISOString();
  registry.updateStatus(workerId, status, { ...options, at });
  registry.appendEvent(workerId, status, at, options.cleanupError ? { cleanupError: options.cleanupError } : undefined);
}

async function contextForRegistryRecord(context: RelayCommandContext, record: GlobalWorkerRecord): Promise<RelayCommandContext> {
  if (path.resolve(record.repository.root) === path.resolve(context.projectRoot)) return context;
  const loaded = await loadRelayConfig(record.repository.root);
  const store = new RepositoryStateStore(loaded.projectRoot);
  const repositoryIdentity = await getRepositoryIdentity(loaded.projectRoot);
  const repository = { id: repositoryIdentity.id, root: repositoryIdentity.root };
  const runs = await store.listRuns();
  if (runs.length > 0) context.registry?.importRuns(runs, { repository });
  return {
    projectRoot: loaded.projectRoot,
    config: loaded.config,
    store,
    logger: createEventLogger(loaded.projectRoot, loaded.config.logging.level, loaded.config.logging.pretty),
    write: context.write,
    registry: context.registry,
    repositoryIdentity,
  };
}

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
    signal: async (context, target, outcome, options) => {
      const candidates = (await context.store.listRuns())
        .filter((run) => run.id === target || run.worker?.id === target || run.item.id.toLowerCase() === target.toLowerCase())
        .sort((left, right) => right.claimedAt.localeCompare(left.claimedAt));
      if (candidates.length === 0) throw new Error(`No run or worker found for '${target}'.`);
      const active = candidates.filter((run) => ["claimed", "provisioning", "launching", "running"].includes(run.status));
      const selectable = active.length > 0 ? active : candidates;
      if (selectable.length > 1) throw new Error(`More than one worker matches '${target}'. Use the exact worker id from 'relay runs --json'.`);
      const run = selectable[0];
      const at = new Date().toISOString();
      // Outputs are recorded before the terminal transition: a workflow job that
      // reads needs.<job>.outputs must never see a finished job without them.
      const outputs = { ...options.outputs, ...(options.message ? { message: options.message } : {}) };
      if (Object.keys(outputs).length > 0) {
        await context.store.recordWorkerOutputs(run.identity, run.claimedAt, outputs, at);
      }
      if (!active.includes(run)) {
        context.write(`${run.item.id}: worker already ${run.status}; recorded ${Object.keys(outputs).length} output(s).`);
        return;
      }
      const status = outcome === "done" ? "succeeded" : "failed";
      const finished = await context.store.finishActive(run.identity, run.claimedAt, { status, completedAt: at, ...(outcome === "failed" ? { error: options.message ?? "Worker reported failure." } : {}) });
      if (!finished) throw new Error(`Worker for ${run.item.id} changed before its result could be recorded.`);
      const runtime = await composeRuntime(context);
      try {
        const source = runtime.sources.get(run.identity.sourceId);
        if (source) await source.report({ type: status, sourceId: source.id, run: finished, occurredAt: at, error: finished.error });
      } finally { await runtime.relay.stop(); }
      context.write(`${run.item.id}: recorded ${status}${Object.keys(outputs).length ? ` with ${Object.keys(outputs).length} output(s)` : ""}.`);
    },
    workerControl: async (context, target, action) => {
      const { registry, registryRepository } = await ensureRegistryContext(context);
      const candidates = (await context.store.listRuns())
        .filter((run) => run.worker && (run.id === target || run.worker.id === target || run.item.id.toLowerCase() === target.toLowerCase()))
        .sort((left, right) => right.claimedAt.localeCompare(left.claimedAt));
      const run = candidates.find((candidate) => ["claimed", "provisioning", "launching", "running"].includes(candidate.status)) ?? candidates[0];
      if (!run?.worker) throw new Error(`No worker found for '${target}'.`);
      const registered = registry.syncRun(run, { repository: registryRepository });
      addIssueToLegacyTmuxMetadata(run, registered.id);
      registry.syncRun(run, { repository: registryRepository });

      // Controlling a live worker needs only its execution adapter, not a whole
      // relay: composing one would connect every source for a single key press.
      const executor = context.config.execution.adapter === "tmux"
        ? new TmuxExecutionAdapter({ session: context.config.execution.tmuxSession || `task-relay-${context.config.project.name || path.basename(context.projectRoot)}` })
        : new DirectProcessAdapter();
      const runtime = executor.runtime;
      if (!runtime?.capabilities.input) throw new Error("Controlling a running worker requires execution.adapter: tmux.");

      if (action.type === "send") {
        await runtime.sendInput(run.worker, { text: action.text, submit: action.submit !== false });
        return `Sent ${action.text.length} characters to ${run.worker.id}.`;
      }
      const child = await runtime.open(run.worker, {
        command: action.command,
        args: action.args ?? [],
        open: action.open ?? "pane",
        ...(action.name ? { name: action.name } : {}),
      });
      await context.store.recordWorkerChild(run.identity, run.claimedAt, child, new Date().toISOString());
      return `Opened ${child.kind} ${child.target} running ${child.command}.`;
    },
    workflowTest: async (context, id) => {
      // Guarded here rather than in the CLI so every caller — including the
      // dashboard — gets the same precise message.
      if (!context.config.workflows[id]) {
        const known = Object.keys(context.config.workflows);
        throw new Error(`Unknown workflow '${id}'.${known.length ? ` Configured workflows: ${known.join(", ")}.` : " None are configured."}`);
      }
      const runtime = await composeRuntime(context, { trigger: id });
      try {
        const workflow = runtime.workflows[0];
        const source = workflow && runtime.sources.get(workflow.sourceId);
        if (!workflow || !source) throw new Error(`Workflow ${id} could not be composed.`);
        const items = await source.discover({ trigger: { id: workflow.id, sourceId: workflow.sourceId, repository: workflow.repository, enabled: true, selector: workflow.selector } });
        context.write(`Workflow: ${workflow.id}\nSource: ${workflow.sourceId}\nFire: ${workflow.firePolicy ?? "once-per-match"}\nMatches: ${items.length}`);
        for (const item of items) {
          const existing = await context.store.latestWorkflowRun({ repository: workflow.repository, workflowId: workflow.id, sourceId: item.sourceId, itemId: item.id });
          const states = existing?.jobs ?? {};
          context.write(`  ${item.id}  ${item.title}${existing ? `  [run ${existing.identity.occurrence}: ${existing.status}]` : "  [no run yet]"}`);
          const known = new Set(workflow.jobs.map((job) => job.id));
          for (const job of workflow.jobs) {
            const decision = decideJob({ job, states, item, known });
            const detail = decision.action === "run" ? "would start now" : decision.reason;
            context.write(`      ${job.id.padEnd(20)} ${job.use.padEnd(28)} ${detail}`);
          }
        }
        context.write("Dry run only; no action, source, workspace, or worker changes were made.");
      } finally { await runtime.relay.stop(); }
    },
    daemon: async (context, action) => {
      const daemon = new RepositoryDaemon(context.projectRoot);
      context.write(action === "start" ? await daemon.start() : action === "stop" ? await daemon.stop() : await daemon.status());
    },
    attach: async (context, target) => {
      const { registry } = await ensureRegistryContext(context);
      let targetContext = context;
      let candidates = (await targetContext.store.listRuns())
        .filter((run) => run.worker && (run.id === target || run.worker.id === target || run.item.id.toLowerCase() === target.toLowerCase()))
        .filter((run) => Object.keys(asRecord(run.worker?.metadata?.tmux)).length > 0)
        .sort((left, right) => right.claimedAt.localeCompare(left.claimedAt));
      if (candidates.length === 0) {
        const record = chooseRegistryCandidate(registryCandidates(registry, target), target);
        if (record) {
          targetContext = await contextForRegistryRecord(context, record);
          candidates = (await targetContext.store.listRuns())
            .filter((run) => run.worker && (run.id === record.runId || run.worker.id === record.id || run.item.id.toLowerCase() === record.itemId.toLowerCase()))
            .filter((run) => Object.keys(asRecord(run.worker?.metadata?.tmux)).length > 0)
            .sort((left, right) => right.claimedAt.localeCompare(left.claimedAt));
          if (candidates.length === 0 && record.snapshot.worker) candidates = [record.snapshot];
        }
      }
      if (candidates.length === 0) throw new Error(`No attachable tmux worker found for '${target}'.`);
      const active = candidates.find((run) => ["claimed", "provisioning", "launching", "running"].includes(run.status));
      const run = active ?? candidates[0];
      const registered = registry.syncRun(run, { repository: { id: targetContext.repositoryIdentity!.id, root: targetContext.repositoryIdentity!.root } });
      addIssueToLegacyTmuxMetadata(run, registered.id);
      registry.syncRun(run, { repository: { id: targetContext.repositoryIdentity!.id, root: targetContext.repositoryIdentity!.root } });
      const executor = new TmuxExecutionAdapter({ session: targetContext.config.execution.tmuxSession || `task-relay-${targetContext.config.project.name || path.basename(targetContext.projectRoot)}` });
      await executor.attach(run.worker!);
    },
    cleanup: async (context, target) => {
      const { registry } = await ensureRegistryContext(context);
      let targetContext = context;
      let candidates = (await targetContext.store.listRuns()).filter((run) => run.id === target || run.worker?.id === target || run.item.id.toLowerCase() === target.toLowerCase());
      if (candidates.length === 0) {
        const record = chooseRegistryCandidate(registryCandidates(registry, target), target);
        if (record) {
          targetContext = await contextForRegistryRecord(context, record);
          candidates = (await targetContext.store.listRuns()).filter((run) => run.id === record.runId || run.worker?.id === record.id || run.item.id.toLowerCase() === record.itemId.toLowerCase());
        }
      }
      if (candidates.length === 0) throw new Error(`No run or worker found for '${target}'.`);
      const removable = candidates.filter((run) => run.workspace && !run.workspaceCleanedAt);
      if (removable.length === 0) throw new Error(`No removable workspace found for '${target}'.`);
      if (removable.length > 1) throw new Error(`More than one worker workspace matches '${target}'. Use the exact worker or run id from 'relay runs --json'.`);
      const run = removable[0];
      const wasActive = ["claimed", "provisioning", "launching", "running"].includes(run.status);
      const runtime = await composeRuntime(targetContext);
      const record = registry.syncRun(run, { repository: { id: targetContext.repositoryIdentity!.id, root: targetContext.repositoryIdentity!.root } });
      addIssueToLegacyTmuxMetadata(run, record.id);
      registry.syncRun(run, { repository: { id: targetContext.repositoryIdentity!.id, root: targetContext.repositoryIdentity!.root } });
      try {
        if (run.worker && (wasActive || run.worker.metadata?.interactive === true)) {
          await runtime.launcher.stop?.(run.worker, run);
        }
        if (run.workspace) await runtime.workspace.cleanup?.(run.workspace, run);
        let stopped: RunRecord | undefined;
        let cleaned: RunRecord | undefined;
        try {
          stopped = wasActive ? await runtime.runStore.finishActive(run.identity, run.claimedAt, { status: "stopped", completedAt: new Date().toISOString() }) : undefined;
          cleaned = await runtime.runStore.markWorkspaceCleaned(run.identity, run.claimedAt, new Date().toISOString());
          if (!cleaned) throw new Error(`Workspace was removed, but run ${run.id} changed before cleanup state could be recorded.`);
        } catch (error) {
          updateRegistryStatus(registry, record.id, "cleanup_failed", { cleanupError: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        updateRegistryStatus(registry, record.id, "cleaned", { cleanedAt: cleaned.workspaceCleanedAt });
        const source = runtime.sources.get(run.identity.sourceId);
        if (source && stopped) await source.report({ type: "stopped", sourceId: source.id, run: stopped, occurredAt: stopped.completedAt! });
        targetContext.write(`Cleaned ${run.item.id}: ${stopped ? "worker stopped and " : ""}workspace removed.`);
      } finally { await runtime.relay.stop(); }
    },
  };
}

async function composeRuntime(context: RelayCommandContext, filters: { trigger?: string; task?: string } = {}): Promise<RuntimeComposition> {
  const { registry, repository, registryRepository } = await ensureRegistryContext(context);
  const plugins = await pluginRegistry(context.config, context.projectRoot, filters.trigger);
  const triggers = context.config.triggers
    .filter((trigger) => !filters.trigger || trigger.id === filters.trigger)
    .map((trigger) => domainTrigger(context.config, trigger, repository));
  const lock = await readPluginLock();
  const packageDirectory = (name: string) => {
    const installed = findInstalledPlugin(lock, name);
    return installed ? path.dirname(installed.entry).replace(/\/dist$/, "") : undefined;
  };
  const workflows: WorkflowDefinition[] = [];
  for (const [id, workflow] of Object.entries(context.config.workflows)) {
    if (filters.trigger && id !== filters.trigger) continue;
    const reusable = workflow.use
      ? await loadReusableWorkflow({ specifier: workflow.use, projectRoot: context.projectRoot, with: workflow.with, lookup: packageDirectory, subject: `Workflow '${id}'` })
      : undefined;
    workflows.push(domainWorkflow(context.config, id, workflow, repository, reusable?.jobs));
  }
  if (filters.trigger && triggers.length === 0 && workflows.length === 0) throw new Error(`Unknown trigger or workflow '${filters.trigger}'.`);
  for (const trigger of triggers) {
    for (const action of trigger.actions ?? []) plugins.parseActionConfig(action.use, action.config ?? {});
  }
  for (const workflow of workflows) {
    for (const job of workflow.jobs) plugins.parseActionConfig(job.use, job.config ?? {});
  }

  const sources = new Map<string, WorkSource>();
  for (const sourceId of new Set([...triggers.map((trigger) => trigger.sourceId), ...workflows.map((workflow) => workflow.sourceId)])) {
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
  const commandLauncher = new CommandAgentLauncher({ profiles: harnessProfiles(context.config), executor, windowNameTemplate: context.config.execution.tmuxWindowName, repositoryIdentity: registryRepository.id });
  const harnessPlugins = pluginHarnesses(context.config, plugins);
  const configuredLauncher = harnessPlugins.length > 0 ? new CompositeAgentLauncher(commandLauncher, harnessPlugins) : commandLauncher;
  const launcher = new RegistryAgentLauncher(configuredLauncher, registry, registryRepository);
  const configuredWorkspace = context.config.workspace.adapter === "git-worktree"
    ? new GitWorktreeProvider({ baseBranch: context.config.workspace.baseBranch, branchTemplate: context.config.workspace.branchTemplate, worktreeRoot: path.resolve(context.projectRoot, context.config.workspace.directory) })
    : new WtWorkspaceProvider({ baseBranch: context.config.workspace.baseBranch, branchTemplate: context.config.workspace.branchTemplate, worktreeRoot: path.resolve(context.projectRoot, context.config.workspace.directory) });
  const workspace = new RegistryWorkspaceProvider(configuredWorkspace, registry, registryRepository);
  const eventStore = new EventingRunStore(context.store, context.logger, repository.id, registry, registryRepository);
  const triggerProvider: TriggerProvider = { list: async () => triggers };
  const relay = new TaskRelay({
    triggers: triggerProvider,
    workflows: { list: async () => workflows },
    workflowRuns: context.store,
    sources: sources.values(),
    runStore: eventStore,
    workspaceProvider: workspace,
    agentLauncher: launcher,
    actionPlugins: plugins,
    actionExecutions: context.store,
    validateLaunch: (request, where) => validateLaunchRequest(context.config, request, `Action '${where.actionId}' in trigger '${where.triggerId}'`),
    oneWorkerPerItem: context.config.execution.oneWorkerPerItem,
    logger: relayLogger(context.logger, repository.id),
  });
  return { relay, sources, triggers, workflows, launcher, workspace, runStore: eventStore, plugins };
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

/**
 * Turns one `workflows:` entry into the engine's workflow definition. A job's
 * `use` may name a reusable `actions:` entry or a plugin directly, so the same
 * action can be shared by several workflows without being copied.
 */
export function domainWorkflow(config: RelayConfigV2, id: string, workflow: RelayWorkflowV2, repository: RepositoryScope, declared?: Record<string, RelayWorkflowJobV2>): WorkflowDefinition {
  const source = config.sources[workflow.on.source];
  if (source?.use === "linear" && !isLinearTriggerSelector(workflow.on.match)) {
    throw new Error(`Workflow '${id}' has an invalid Linear match configuration.`);
  }
  const declaredJobs = declared ?? workflow.jobs;
  if (!declaredJobs) throw new Error(`Workflow '${id}' declares no jobs.`);

  const jobs = Object.entries(declaredJobs)
    .filter(([, job]) => job.enabled)
    .flatMap(([jobId, job]): WorkflowJobDefinition[] => {
      const reused = config.actions[job.use];
      const use = reused?.use ?? job.use;
      const base = reused ? { ...asRecord(reused.with), ...asRecord(job.with) } : job.with;
      // A matrix job becomes one instance per combination, all sharing the
      // declared name as their group so `needs: <name>` still addresses them all.
      return matrixCombinations(job.strategy?.matrix).map((values): WorkflowJobDefinition => {
        const instanceId = values ? `${jobId} (${describeMatrix(values)})` : jobId;
        const resolved = values ? bindMatrix(base, values) : base;
        if (use === "launch") {
          const launchConfig = asRecord(resolved);
          validateLaunchRequest(config, { harness: stringValue(launchConfig.harness) ?? "", mode: launchConfig.mode as LaunchWorkerActionRequest["mode"] }, `Job '${instanceId}' in workflow '${id}'`);
        }
        return {
          id: instanceId,
          group: jobId,
          use,
          config: resolved,
          needs: parseNeeds(job.needs),
          ...(job.if ? { if: job.if } : {}),
          ...(values ? { matrix: values } : {}),
          ...(job.timeoutMinutes ? { timeoutMs: job.timeoutMinutes * 60_000 } : {}),
          continueOnError: job.continueOnError,
        };
      });
    });
  if (jobs.length === 0) throw new Error(`Workflow '${id}' has no enabled jobs.`);
  return {
    id,
    sourceId: workflow.on.source,
    repository,
    enabled: workflow.enabled,
    selector: asRecord(workflow.on.match),
    firePolicy: workflow.on.fire.policy,
    maxConcurrent: workflow.maxConcurrent || config.execution.maxConcurrent,
    targets: workflow.targets,
    timeoutMs: workflow.timeoutMinutes * 60_000,
    ...(workflow.concurrency ? { concurrency: { group: workflow.concurrency.group, cancelInProgress: workflow.concurrency.cancelInProgress } } : {}),
    metadata: {
      baseBranch: config.workspace.baseBranch,
      branchTemplate: config.workspace.branchTemplate || `${config.workspace.branchPrefix}/{{key}}-{{slug}}`,
    },
    jobs,
  };
}

/** The cartesian product of a matrix, or a single undefined for a plain job. */
function matrixCombinations(matrix: Record<string, readonly (string | number | boolean)[]> | undefined): (Record<string, unknown> | undefined)[] {
  if (!matrix) return [undefined];
  const names = Object.keys(matrix);
  if (names.length === 0) return [undefined];
  let combinations: Record<string, unknown>[] = [{}];
  for (const name of names) {
    combinations = combinations.flatMap((partial) => matrix[name].map((value) => ({ ...partial, [name]: value })));
  }
  return combinations;
}

function describeMatrix(values: Record<string, unknown>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join(", ");
}

/** Substitutes `${{ matrix.name }}` through a job's configuration. */
function bindMatrix(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_.:-]+)\s*\}\}/g, (whole, name: string) => {
      const bound = values[name];
      if (bound === undefined) throw new Error(`Matrix has no value named '${name}'.`);
      return String(bound);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => bindMatrix(entry, values));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bindMatrix(entry, values)]));
  }
  return value;
}

/** Accepts `implement`, `implement.Started`, and the explicit object form. */
function parseNeeds(needs: RelayWorkflowJobV2["needs"]): WorkflowNeed[] {
  const list = needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];
  return list.map((need) => {
    if (typeof need !== "string") return need.status ? { job: need.job, status: need.status } : { job: need.job };
    const [job, suffix] = need.split(".", 2);
    if (!suffix) return { job };
    const status = suffix.toLowerCase();
    if (status !== "started" && status !== "succeeded" && status !== "failed" && status !== "skipped") {
      throw new Error(`Unknown job status '${suffix}' in needs '${need}'. Use Started, Succeeded, Failed, or Skipped.`);
    }
    return { job, status };
  });
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
    // Built-in launch config is known statically, so its errors surface at
    // config-load time. Every other action goes through the same rules at
    // dispatch time via validateLaunchRequest below.
    if (resolved.use === "launch") {
      const launchConfig = asRecord(resolved.config);
      validateLaunchRequest(config, { harness: stringValue(launchConfig.harness) ?? "", mode: launchConfig.mode as LaunchWorkerActionRequest["mode"] }, `Launch action '${resolved.id}'`);
    }
    return resolved;
  });
}

/**
 * The rules that make a worker launch possible, applied to the request rather
 * than to the name of the plugin that issued it. An external action that wraps
 * `workers.launch` gets exactly the same errors as the built-in `launch`.
 */
export function validateLaunchRequest(config: RelayConfigV2, request: Pick<LaunchWorkerActionRequest, "harness" | "mode">, subject: string): void {
  if (!request.harness) throw new Error(`${subject} requires 'with.harness'.`);
  const harness = config.harnesses[request.harness];
  if (!harness) {
    const known = Object.keys(config.harnesses);
    throw new Error(`${subject} references unknown harness '${request.harness}'.${known.length ? ` Configured harnesses: ${known.join(", ")}.` : " No harnesses are configured."}`);
  }
  // Only a command harness needs a terminal from Relay. A harness plugin starts
  // and owns its own process, so the adapter is not its concern.
  if (request.mode === "interactive" && isCommandHarness(harness) && config.execution.adapter !== "tmux") {
    throw new Error(`${subject} uses interactive mode, which requires execution.adapter: tmux.`);
  }
}

/** True when this harness is run through Relay's command launcher rather than a plugin. */
export function isCommandHarness(definition: RelayConfigV2["harnesses"][string]): boolean {
  return definition.use === "command" || (BUILT_IN_HARNESS_PROFILES as readonly string[]).includes(definition.use);
}

export function harnessProfiles(config: RelayConfigV2): CommandAgentProfile[] {
  return Object.entries(config.harnesses)
    .filter(([, definition]) => isCommandHarness(definition))
    .map(([id, definition]) => {
      const overrides = asRecord(definition.with);
      if (definition.use === "command") return { ...overrides, id } as CommandAgentProfile;
      const base = builtInHarnessProfile(definition.use as typeof BUILT_IN_HARNESS_PROFILES[number]);
      return { ...base, ...overrides, id } as CommandAgentProfile;
    });
}

/** Harness plugins bound to their validated configuration, in declaration order. */
function pluginHarnesses(config: RelayConfigV2, plugins: RelayPluginRegistry): ConfiguredHarnessPlugin[] {
  return Object.entries(config.harnesses)
    .filter(([, definition]) => !isCommandHarness(definition))
    .map(([id, definition]) => {
      const plugin = plugins.harness(definition.use);
      if (!plugin) throw new Error(`Harness '${id}' uses unknown harness plugin '${definition.use}'.`);
      return { id, plugin, config: plugins.parseHarnessConfig(definition.use, definition.with) };
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

/**
 * Loads only the plugins the selected work can actually reach.
 *
 * Scoping matters for `trigger test` and `workflow test`: a dry run of one
 * workflow must not fail because an unrelated action elsewhere in the file
 * names a plugin that is not installed. Harnesses stay unscoped, because any
 * action may launch any of them.
 */
async function pluginRegistry(config: RelayConfigV2, projectRoot: string, selected?: string): Promise<RelayPluginRegistry> {
  const registry = new RelayPluginRegistry();
  for (const plugin of builtInActionPlugins()) registry.register(plugin);
  const externalUses = new Set<string>();

  const triggers = config.triggers.filter((trigger) => !selected || trigger.id === selected);
  const workflows = Object.entries(config.workflows).filter(([id]) => !selected || id === selected);
  const sourceIds = new Set([...triggers.map((trigger) => trigger.source), ...workflows.map(([, workflow]) => workflow.on.source)]);
  const namedActions = new Set<string>();
  for (const trigger of triggers) for (const action of trigger.actions) if (typeof action === "string") namedActions.add(action);
  for (const [, workflow] of workflows) for (const job of Object.values(workflow.jobs ?? {})) if (config.actions[job.use]) namedActions.add(job.use);

  for (const [id, source] of Object.entries(config.sources)) if (sourceIds.has(id) && !BUILT_IN_SOURCES.has(source.use)) externalUses.add(source.use);
  for (const harness of Object.values(config.harnesses)) if (!isCommandHarness(harness)) externalUses.add(harness.use);
  for (const [id, action] of Object.entries(config.actions)) if (namedActions.has(id) && !registry.action(action.use)) externalUses.add(action.use);
  for (const [, workflow] of workflows) for (const job of Object.values(workflow.jobs ?? {})) if (!registry.action(job.use) && !config.actions[job.use]) externalUses.add(job.use);
  for (const trigger of triggers) for (const action of trigger.actions) if (typeof action !== "string" && !registry.action(action.use)) externalUses.add(action.use);
  // Read the managed lockfile once, not once per plugin.
  const lock = externalUses.size > 0 ? await readPluginLock() : undefined;
  for (const use of externalUses) registry.registerAs(use, await loadRelayPlugin(use, projectRoot, lock));
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

/** Adds global cleanup lifecycle tracking without coupling the core engine to SQLite. */
class RegistryAgentLauncher implements AgentLauncher {
  constructor(
    private readonly launcher: AgentLauncher,
    private readonly registry: GlobalWorkerRegistry,
    private readonly repository: RepositoryScope,
  ) {}

  get runtime(): WorkerRuntime | undefined { return this.launcher.runtime; }
  resolve(profile: AgentProfile | undefined, item: WorkItem, trigger: TriggerDefinition): Promise<AgentResolution> { return this.launcher.resolve(profile, item, trigger); }
  launch(spec: Parameters<AgentLauncher["launch"]>[0]): Promise<WorkerHandle> { return this.launcher.launch(spec); }
  wait(worker: WorkerHandle, run: RunRecord): Promise<WorkerCompletion | undefined> { return this.launcher.wait?.(worker, run) ?? Promise.resolve(undefined); }
  reconcile(worker: WorkerHandle, run: RunRecord): Promise<WorkerCompletion | undefined> { return this.launcher.reconcile?.(worker, run) ?? Promise.resolve(undefined); }
  async stop(worker: WorkerHandle, run: RunRecord): Promise<void> {
    const record = this.registry.syncRun(run, { repository: this.repository });
    updateRegistryStatus(this.registry, record.id, "stopping");
    try {
      if (!this.launcher.stop) throw new Error("The configured agent launcher cannot stop workers.");
      await this.launcher.stop(worker, run);
      updateRegistryStatus(this.registry, record.id, "processes_stopped");
    } catch (error) {
      updateRegistryStatus(this.registry, record.id, "cleanup_failed", { cleanupError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

class RegistryWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly workspace: WorkspaceProvider,
    private readonly registry: GlobalWorkerRegistry,
    private readonly repository: RepositoryScope,
  ) {}

  provision(run: RunRecord, signal?: AbortSignal): Promise<Workspace> { return this.workspace.provision(run, signal); }
  async cleanup(workspace: Workspace, run: RunRecord): Promise<void> {
    const record = this.registry.syncRun(run, { repository: this.repository });
    updateRegistryStatus(this.registry, record.id, "workspace_removing");
    try { await this.workspace.cleanup?.(workspace, run); }
    catch (error) {
      updateRegistryStatus(this.registry, record.id, "cleanup_failed", { cleanupError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

class EventingRunStore implements RunStore {
  constructor(
    private readonly store: RunStore,
    private readonly logger: Logger,
    private readonly project: string,
    private readonly registry: GlobalWorkerRegistry,
    private readonly repository: RepositoryScope,
  ) {}
  findActive(identity: RunIdentity) { return this.store.findActive(identity); }
  countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">) { return this.store.countActive(identity); }
  listActive(repository: RepositoryScope) { return this.store.listActive?.(repository) ?? Promise.resolve([]); }
  findRunsForItem(query: Parameters<NonNullable<RunStore["findRunsForItem"]>>[0]) { return this.store.findRunsForItem?.(query) ?? Promise.resolve([]); }
  findWorkerTargets(query: Parameters<NonNullable<RunStore["findWorkerTargets"]>>[0]) { return this.store.findWorkerTargets?.(query) ?? Promise.resolve([]); }
  async claim(claim: RunClaim): Promise<RunRecord | undefined> { const run = await this.store.claim(claim); if (run) this.write(run, "task.claimed"); return run; }
  async finishActive(identity: RunIdentity, claimedAt: string, transition: RunTerminalTransition): Promise<RunRecord | undefined> { const run = await this.store.finishActive(identity, claimedAt, transition); if (run) this.write(run, `run.${run.status}`); return run; }
  async markWorkspaceCleaned(identity: RunIdentity, claimedAt: string, cleanedAt: string): Promise<RunRecord | undefined> { const run = await this.store.markWorkspaceCleaned(identity, claimedAt, cleanedAt); if (run) this.write(run, "run.workspace.cleaned"); return run; }
  async recordWorkerChild(identity: RunIdentity, claimedAt: string, child: WorkerChildHandle, recordedAt: string): Promise<RunRecord | undefined> { const run = await this.store.recordWorkerChild?.(identity, claimedAt, child, recordedAt); if (run) this.write(run, "run.worker.child.opened"); return run; }
  async recordWorkerOutputs(identity: RunIdentity, claimedAt: string, outputs: Record<string, unknown>, recordedAt: string): Promise<RunRecord | undefined> { const run = await this.store.recordWorkerOutputs?.(identity, claimedAt, outputs, recordedAt); if (run) this.write(run, "run.worker.outputs.recorded"); return run; }
  async update(run: RunRecord): Promise<void> { await this.store.update(run); this.write(run, `run.${run.status}`); }
  private write(run: RunRecord, event: string): void {
    const record = this.registry.syncRun(run, { repository: this.repository });
    this.registry.appendEvent(record.id, event, run.updatedAt);
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
  const isNoise = (outcome: TickResult["items"][number]) => outcome.status === "skipped" && (outcome.reason?.endsWith("No matching workers.") || outcome.reason === "Ticket is terminal.");
  const suppressedSkips = result.items.filter(isNoise);
  const rows: TickTableRow[] = result.items
    .filter((outcome) => !isNoise(outcome))
    .map((outcome) => ({
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
  const suppressedNote = suppressedSkips.length ? ` (${suppressedSkips.length} cleanup no-ops hidden)` : "";
  context.write(`Tick: ${result.itemsDiscovered} discovered | ${result.actionsExecuted} actions | ${result.runsLaunched} workers launched | ${result.actionsFailed} action failures | ${result.skipped} skipped${suppressedNote}`);
  context.write(rows.length ? tickTable(rows) : "No matching tickets or running workers.");
}
