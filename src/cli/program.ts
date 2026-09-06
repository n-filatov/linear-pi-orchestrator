import { inspectWorkflowRun, redactExecution } from "../application/execution-inspection.js";
import { execFileSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { Command } from "commander";
import { confirm, input, number, select } from "@inquirer/prompts";
import { resolve } from "node:path";
import { renderRelayConfig, findProjectRoot, loadRelayConfig, CONFIG_FILE, LOCAL_CONFIG_FILE } from "../config/load.js";
import { relayConfigV2Schema, type RelayConfigV2, type RelayTriggerV2 } from "../config/schema.js";
import { createEventLogger, eventLogPath, logEvent, readEvents, stateDirectory } from "../logging/events.js";
import { errorTable, eventsTable, statusTable } from "../logging/tables.js";
import { RepositoryStateStore } from "../state/store.js";
import { GlobalWorkerRegistry, type GlobalWorkerRecord, type GlobalWorkflowRegistry } from "../state/global-worker-registry.js";
import { getRepositoryIdentity, type RepositoryIdentity } from "../state/repository-identity.js";
import { writeFile } from "node:fs/promises";
import { addPluginCommands } from "./plugin-commands.js";
import type { WorkflowJobStatus } from "../domain/index.js";
import type { RelayWorkflowV2 } from "../config/v2.js";

export type RelayCommandContext = {
  projectRoot: string;
  config: RelayConfigV2;
  store: RepositoryStateStore;
  logger: ReturnType<typeof createEventLogger>;
  write: (value: string) => void;
  /** Machine-global worker index, shared by every checkout and Relay process. */
  registry?: GlobalWorkerRegistry;
  /** Global SQLite read model for workflow executions. */
  workflowRegistry?: GlobalWorkflowRegistry;
  /** Stable across clones when a repository has an origin remote. */
  repositoryIdentity?: RepositoryIdentity;
};

/**
 * Read-only preview for one canvas action. It deliberately reports the
 * action's current eligibility rather than predicting outcomes of upstream
 * jobs: dependency outputs only exist once Relay has persisted them.
 */
export type WorkflowActionTestResult = {
  workflowId: string;
  actionId: string;
  sourceId: string;
  triggerMatchCount: number;
  eligibleCount: number;
  items: Array<{
    id: string;
    title: string;
    url?: string;
    state?: string;
    /** True exactly when Relay would start this action on its next tick. */
    eligible: boolean;
    decision: "run" | "hold" | "settle";
    reason: string;
    /** The latest durable workflow state used to make this decision. */
    run: { occurrence: string; status: string; jobStatus?: WorkflowJobStatus } | null;
  }>;
};

/** Read-only eligibility preview for every job in a workflow draft. */
export type WorkflowDraftTestResult = {
  workflowId: string;
  sourceId: string;
  triggerMatchCount: number;
  eligibleCount: number;
  items: Array<{
    id: string;
    title: string;
    url?: string;
    state?: string;
    eligible: boolean;
    decision: "run" | "hold" | "settle";
    reason: string;
    jobs: Array<{
      id: string;
      use?: string;
      eligible: boolean;
      decision: "run" | "hold" | "settle";
      reason: string;
      status?: WorkflowJobStatus;
    }>;
    run: { occurrence: string; status: string } | null;
  }>;
};

export type RelayCommandHandlers = {
  poll?: (context: RelayCommandContext) => Promise<void>;
  stopPolling?: (projectRoot: string) => Promise<void>;
  once?: (context: RelayCommandContext, options: { trigger?: string; task?: string }) => Promise<void>;
  watch?: (context: RelayCommandContext, options: { trigger?: string }) => Promise<void>;
  daemon?: (context: RelayCommandContext, action: "start" | "stop" | "status") => Promise<void>;
  triggerTest?: (context: RelayCommandContext, trigger: RelayTriggerV2) => Promise<void>;
  cleanup?: (context: RelayCommandContext, target: string) => Promise<void>;
  attach?: (context: RelayCommandContext, target: string) => Promise<void>;
  signal?: (context: RelayCommandContext, target: string, outcome: "done" | "failed", options: { outputs: Record<string, string>; message?: string }) => Promise<void>;
  workflowTest?: (context: RelayCommandContext, id: string) => Promise<void>;
  workflowAdopt?: (context: RelayCommandContext, id: string, task: string, occurrence?: string) => Promise<void>;
  /** Read-only eligibility preview for one workflow action/job. */
  workflowActionTest?: (
    context: RelayCommandContext,
    workflowId: string,
    actionId: string,
    options?: { workflow?: RelayWorkflowV2 },
  ) => Promise<WorkflowActionTestResult>;
  /** Read-only eligibility preview for every job in a workflow draft. */
  workflowDraftTest?: (
    context: RelayCommandContext,
    workflowId: string,
    options?: { workflow?: RelayWorkflowV2 },
  ) => Promise<WorkflowDraftTestResult>;
  /** Ad-hoc control of one live worker, used by the dashboard. */
  workerControl?: (context: RelayCommandContext, target: string, action:
    | { type: "send"; text: string; submit?: boolean }
    | { type: "exec"; command: string; args?: string[]; open?: "pane" | "window"; name?: string }
  ) => Promise<string>;
  update?: (options: { check?: boolean; version?: string }) => Promise<string>;
};
export type RelayCliOptions = { handlers?: RelayCommandHandlers; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream; cwd?: () => string };

type InitOptions = { source?: string; harness?: string; /** @deprecated use harness */ agent?: string; label?: string; model?: string; mode?: "oneshot" | "interactive"; prompt?: string; maxConcurrent?: number; yes?: boolean; force?: boolean; dryRun?: boolean };

function executable(command: string): boolean { try { execFileSync("which", [command], { stdio: "ignore" }); return true; } catch { return false; } }
function gitValue(root: string, args: string[]): string | undefined { try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; } }
const BUILT_IN_HARNESSES = ["codex", "claude", "pi", "opencode"] as const;
function firstAvailableHarness(): typeof BUILT_IN_HARNESSES[number] { return BUILT_IN_HARNESSES.find(executable) || "codex"; }
function harnessChoices(): { name: string; value: typeof BUILT_IN_HARNESSES[number] }[] {
  return BUILT_IN_HARNESSES.map((harness) => ({ name: `${harness[0].toUpperCase()}${harness.slice(1)}${executable(harness) ? " (found)" : " (not found)"}`, value: harness }));
}
function harnessAvailabilityRows(): [string, string][] { return BUILT_IN_HARNESSES.map((harness) => [harness, executable(harness) ? "available" : "not found"]); }
export function defaultConfig(options: Required<Pick<InitOptions, "source" | "harness" | "label" | "maxConcurrent" | "mode" | "prompt">> & Pick<InitOptions, "model">, projectName: string, branch: string): RelayConfigV2 {
  const actionId = "implement";
  const cleanupActionId = "cleanup-completed-worker";
  return relayConfigV2Schema.parse({
    version: 2,
    project: { name: projectName },
    sources: {
      [options.source]: {
        use: "linear",
        enabled: true,
        pollIntervalMs: 30_000,
        with: {
          mcp: { transport: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], environment: {} },
          reporting: { runningLabel: "relay:running", blockedLabel: "relay:blocked", doneLabel: "relay:done", inProgressState: "In Progress", commentOnLaunch: true, commentOnFailure: true },
        },
      },
    },
    harnesses: { [options.harness]: { use: options.harness } },
    actions: {
      [actionId]: {
        use: "launch",
        with: {
          harness: options.harness,
          mode: options.mode,
          ...(options.model ? { model: options.model } : {}),
          prompt: options.prompt,
        },
      },
      [cleanupActionId]: {
        use: "cleanup",
        // Terminal automation is deliberately stricter than an ad-hoc cleanup:
        // it only touches a tmux window carrying Relay's durable worker tag.
        with: { activeWorker: "stop", ownedTmuxOnly: true },
      },
    },
    triggers: [
      {
        id: `${options.source}-${options.label.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "tasks"}`,
        source: options.source,
        match: { labels: { all: [options.label], none: ["relay:running", "relay:done", "relay:blocked"] }, assignee: "me" },
        actions: [actionId],
        // A terminal issue can later be reopened. The running/terminal labels
        // make this safe to evaluate on every poll, while the active-run guard
        // prevents duplicate workers during Linear's update propagation.
        fire: { policy: "every-poll" },
        maxConcurrent: options.maxConcurrent,
      },
    ],
    // Terminal cleanup is a durable workflow, rather than a second trigger:
    // one job handles every Relay-owned tmux worker/worktree for this exact
    // Linear item and retains an auditable result for the Done transition.
    workflows: {
      [`${options.source}-cleanup-on-done`]: {
        enabled: true,
        on: {
          source: options.source,
          match: { statusTypes: ["completed"] },
          fire: { policy: "once-per-item" },
        },
        targets: { workers: { sourceItem: "current", runs: "all" } },
        jobs: {
          "cleanup-workers": { use: cleanupActionId },
        },
      },
    },
    workspace: { adapter: "wt", directory: ".task-relay/workspaces", baseBranch: branch, branchPrefix: "relay" },
    execution: { maxConcurrent: options.maxConcurrent, retries: 2, adapter: "tmux", tmuxSession: `task-relay-${projectName.replace(/[^a-zA-Z0-9_.-]+/g, "-")}` },
    logging: { level: "info", pretty: true },
  });
}

/** Health of every plugin this configuration names, for `relay doctor`. */
async function pluginHealth(config: RelayConfigV2 | undefined): Promise<[string, string][]> {
  if (!config) return [];
  const { BUILT_IN_ACTIONS, BUILT_IN_HARNESSES, BUILT_IN_SOURCES } = await import("../plugins/built-ins.js");
  const { checkPlugin, readPluginLock } = await import("../plugins/store.js");
  const uses = new Set<string>();
  for (const source of Object.values(config.sources)) if (!BUILT_IN_SOURCES.has(source.use)) uses.add(source.use);
  for (const action of Object.values(config.actions)) if (!BUILT_IN_ACTIONS.has(action.use)) uses.add(action.use);
  for (const harness of Object.values(config.harnesses)) if (!BUILT_IN_HARNESSES.has(harness.use)) uses.add(harness.use);
  for (const trigger of config.triggers) {
    for (const action of trigger.actions) if (typeof action !== "string" && !BUILT_IN_ACTIONS.has(action.use)) uses.add(action.use);
  }
  for (const workflow of Object.values(config.workflows)) {
    for (const job of Object.values(workflow.jobs ?? {})) if (!BUILT_IN_ACTIONS.has(job.use) && !config.actions[job.use]) uses.add(job.use);
  }
  if (uses.size === 0) return [];

  const lock = await readPluginLock();
  const rows: [string, string][] = [];
  for (const use of uses) {
    // A local module path is resolved against the project, not the plugin store.
    if (use.startsWith(".") || use.startsWith("/")) { rows.push([use, "local module"]); continue; }
    const health = await checkPlugin(use, lock);
    rows.push([use, health.state === "ok" ? `installed ${health.plugin.version}`
      : health.state === "not-installed" ? "not installed — run 'relay plugin install'"
      : health.state === "missing-file" ? "missing on disk — reinstall"
      : "changed since install — reinstall"]);
  }
  return rows;
}

async function resolveContext(cwd: () => string, write: (value: string) => void): Promise<RelayCommandContext> {
  const loaded = await loadRelayConfig(cwd());
  const store = new RepositoryStateStore(loaded.projectRoot);
  const repositoryIdentity = await getRepositoryIdentity(loaded.projectRoot);
  const registry = new GlobalWorkerRegistry();
  const repository = { id: repositoryIdentity.id, root: repositoryIdentity.root };
  const runs = await store.listRuns();
  if (runs.length > 0) registry.importRuns(runs, { repository });
  return { projectRoot: loaded.projectRoot, config: loaded.config, store, logger: createEventLogger(loaded.projectRoot, loaded.config.logging.level, loaded.config.logging.pretty), write, registry, repositoryIdentity };
}

async function openGlobalRegistry(cwd: () => string): Promise<GlobalWorkerRegistry> {
  const registry = new GlobalWorkerRegistry();
  try {
    const loaded = await loadRelayConfig(cwd());
    const identity = await getRepositoryIdentity(loaded.projectRoot);
    const repository = { id: identity.id, root: identity.root };
    const store = new RepositoryStateStore(loaded.projectRoot);
    const runs = await store.listRuns();
    if (runs.length > 0) registry.importRuns(runs, { repository });
  } catch {
    // Global inspection intentionally works outside a configured repository.
  }
  return registry;
}

async function resolveWorkerContext(cwd: () => string, write: (value: string) => void, target: string): Promise<RelayCommandContext> {
  try { return await resolveContext(cwd, write); }
  catch (localError) {
    const registry = await openGlobalRegistry(cwd);
    const normalized = target.toLowerCase();
    const candidates = registry.list({ includeCleaned: true }).filter((entry) => entry.id === target
      || entry.runId === target
      || entry.snapshot.worker?.id === target
      || entry.issueKey.toLowerCase() === normalized
      || entry.itemId.toLowerCase() === normalized);
    const scopes = new Set(candidates.map((entry) => `${entry.repository.id}\u0000${entry.sourceId}`));
    if (scopes.size > 1) {
      registry.close();
      throw new Error(`More than one repository or source matches '${target}'. Use the exact worker id from 'relay worker list --json'.`);
    }
    const record = candidates.find((entry) => ["claimed", "provisioning", "launching", "running", "stopping"].includes(entry.status)) ?? candidates[0];
    if (!record) { registry.close(); throw localError; }
    try {
      const loaded = await loadRelayConfig(record.repository.root);
      const store = new RepositoryStateStore(loaded.projectRoot);
      const repositoryIdentity = await getRepositoryIdentity(loaded.projectRoot);
      const repository = { id: repositoryIdentity.id, root: repositoryIdentity.root };
      const runs = await store.listRuns();
      if (runs.length > 0) registry.importRuns(runs, { repository });
      return { projectRoot: loaded.projectRoot, config: loaded.config, store, logger: createEventLogger(loaded.projectRoot, loaded.config.logging.level, loaded.config.logging.pretty), write, registry, repositoryIdentity };
    } catch (error) {
      registry.close();
      throw error;
    }
  }
}

function workerSummary(worker: GlobalWorkerRecord): string {
  const tmux = [worker.runtime.tmuxSession, worker.runtime.tmuxWindow, worker.runtime.tmuxPane].filter(Boolean).join(":") || "not recorded";
  return statusTable([
    ["Issue", worker.issueKey], ["Status", worker.status], ["Worker", worker.id], ["Run", worker.runId],
    ["Repository", worker.repository.id], ["Repository root", worker.repository.root], ["Source", worker.sourceId],
    ["Workspace", worker.workspacePath || "not provisioned"], ["Branch", worker.branch || "not recorded"], ["Harness", worker.harness || "not recorded"], ["tmux", tmux],
    ["Updated", worker.updatedAt], ...(worker.cleanupError ? [["Cleanup error", worker.cleanupError] as [string, string]] : []),
  ]);
}
function noHandler(command: string): never { throw new Error(`${command} is available in the CLI but no runtime integration has been registered. Wire RelayCommandHandlers when composing the application.`); }

export function createRelayProgram(options: RelayCliOptions = {}): Command {
  const output = options.stdout || process.stdout;
  const error = options.stderr || process.stderr;
  const cwd = options.cwd || (() => process.cwd());
  const print = (value: string) => output.write(`${value}\n`);
  const program = new Command();
  program.name("relay").description("Route repository-scoped source tasks to isolated coding-agent workspaces.").version("0.1.0");
  program.showSuggestionAfterError();

  program.command("init").description(`Create a commit-safe ${CONFIG_FILE} in this repository.`)
    .option("--source <name>", "source name", "linear").option("--harness <name>", "agent harness: codex, claude, pi, or opencode")
    .option("--agent <name>", "deprecated alias for --harness").option("--label <label>", "source label to route")
    .option("--model <model>", "model passed to the selected harness").option("--mode <mode>", "worker mode: interactive or oneshot")
    .option("--prompt <template>", "launch prompt template")
    .option("--max-concurrent <count>", "maximum simultaneous runs", (value) => Number(value)).option("--yes", "accept inferred defaults")
    .option("--force", "replace an existing config").option("--dry-run", "print config without writing")
    .action(async (init: InitOptions) => {
      const projectRoot = await findProjectRoot(cwd()); const target = resolve(projectRoot, CONFIG_FILE);
      if (existsSync(target) && !init.force) throw new Error(`${target} already exists. Use --force to replace it.`);
      const inferredHarness = init.harness || init.agent || firstAvailableHarness();
      const defaults = { source: init.source || "linear", harness: inferredHarness, label: init.label || "relay:implement", model: init.model, mode: init.mode || "interactive" as const, prompt: init.prompt || "Implement {{item.id}}: {{item.title}}\n\n{{item.description}}", maxConcurrent: init.maxConcurrent || 2 };
      const answers = init.yes ? defaults : {
        source: await input({ message: "Source name", default: defaults.source }),
        harness: await select({ message: "Agent harness", default: defaults.harness, choices: harnessChoices() }),
        label: await input({ message: "Trigger label", default: defaults.label }),
        model: (await input({ message: "Model ID (leave empty to use the agent default)", default: defaults.model || "" })).trim() || undefined,
        mode: await select({ message: "Worker mode", default: defaults.mode, choices: [{ name: "Interactive tmux session", value: "interactive" as const }, { name: "One-shot background command", value: "oneshot" as const }] }),
        prompt: (await input({ message: "Prompt template", default: defaults.prompt })).trim() || defaults.prompt,
        maxConcurrent: await number({ message: "Maximum concurrent runs", default: defaults.maxConcurrent, min: 1, max: 32 }),
      };
      const repoName = gitValue(projectRoot, ["config", "--get", "remote.origin.url"])?.split("/").pop()?.replace(/\.git$/, "") || resolve(projectRoot).split("/").pop() || "project";
      const remoteBranch = gitValue(projectRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])?.replace(/^origin\//, "");
      const branch = remoteBranch || gitValue(projectRoot, ["branch", "--show-current"]) || "main";
      const resolvedAnswers = { ...answers, maxConcurrent: answers.maxConcurrent ?? defaults.maxConcurrent };
      const config = defaultConfig(resolvedAnswers, repoName, branch); const document = `# Task Relay configuration. Safe to commit: do not put credentials here.\n# Personal machine-only changes belong in ${LOCAL_CONFIG_FILE}; keep it untracked and never store secrets in Relay YAML.\n${renderRelayConfig(config)}`;
      print(statusTable([["Repository", projectRoot], ["Project", repoName], ["Base branch", branch], ...harnessAvailabilityRows(), ["wt", executable("wt") ? "available" : "not found"], ["tmux", executable("tmux") ? "available" : "not found"]]));
      if (!init.yes && !init.dryRun && !(await confirm({ message: `Write ${CONFIG_FILE}?`, default: true }))) return;
      if (init.dryRun) { print(document); return; }
      await writeFile(target, document); print(`Created ${target}`);
    });

  program.command("doctor").description("Check repository configuration, plugins, and required local executables.").action(async () => {
    const root = await findProjectRoot(cwd()); let configuration = "missing";
    let loaded: Awaited<ReturnType<typeof loadRelayConfig>> | undefined;
    try { loaded = await loadRelayConfig(root); configuration = "valid"; } catch (cause) { configuration = cause instanceof Error ? cause.message : "invalid"; }
    const { pluginDirectory } = await import("../plugins/store.js");
    const rows: [string, string | number][] = [["Project root", root], ["Configuration", configuration], ...harnessAvailabilityRows(), ["wt", executable("wt") ? "available" : "not found"], ["tmux", executable("tmux") ? "available" : "not found"], ["State directory", stateDirectory(root)], ["Plugin directory", pluginDirectory()]];
    // A configured plugin that is missing or altered must be reported before a
    // worker is launched, not when the first tick tries to import it.
    for (const [use, health] of await pluginHealth(loaded?.config)) rows.push([`Plugin ${use}`, health]);
    print(statusTable(rows));
  });

  const stateCommand = program.command("state").description("Manage the local execution ledger.");
  stateCommand.command("migrate").description("Import legacy JSON state into SQLite after stopping old Relay processes.").action(async () => {
    const loaded = await loadRelayConfig(cwd());
    const { RepositoryDaemon } = await import("../daemon.js");
    if ((await new RepositoryDaemon(loaded.projectRoot).status()).includes("is running")) {
      throw new Error("Stop the repository daemon before migrating execution state.");
    }
    if (existsSync(resolve(stateDirectory(loaded.projectRoot), "supervisor.lease.lock"))) {
      throw new Error("Stop dashboard supervision before migrating execution state.");
    }
    const store = new RepositoryStateStore(loaded.projectRoot, { migrateLegacy: true });
    try {
      const snapshot = await store.snapshot();
      print(`Execution ledger: ${store.databaseFile}`);
      print(`Verified ${Object.keys(snapshot.runs).length} workers, ${Object.keys(snapshot.workflows).length} workflows, ${Object.keys(snapshot.actions).length} action records.`);
      print("Legacy JSON, when present, was preserved with a pre-sqlite backup. Use this Relay version for future execution.");
    } finally { store.close(); }
  });
  program.command("status").description("Show repository relay state.").action(async () => { const context = await resolveContext(cwd, print); const runs = await context.store.listRuns(); print(statusTable([["Project", context.config.project.name || context.projectRoot], ["Sources", Object.keys(context.config.sources).length], ["Harnesses", Object.keys(context.config.harnesses).length], ["Actions", Object.keys(context.config.actions).length], ["Triggers", context.config.triggers.filter((trigger) => trigger.enabled).length], ["Workflows", Object.values(context.config.workflows).filter((workflow) => workflow.enabled).length], ["Active runs", runs.filter((run) => ["claimed", "provisioning", "launching", "running"].includes(run.status)).length], ["State", context.store.databaseFile], ["Log", eventLogPath(context.projectRoot)]])); });

  program.command("runs").description("List persisted runs.").option("--json", "emit JSON").action(async (flags: { json?: boolean }) => { const context = await resolveContext(cwd, print); const runs = await context.store.listRuns(); if (flags.json) print(JSON.stringify(runs, null, 2)); else print(eventsTable(runs.map((run) => ({ project: context.config.project.name || context.projectRoot, timestamp: run.claimedAt, level: run.status === "failed" ? "error" : "info", task: run.item.id, trigger: run.trigger.id, agent: run.agent.agentId, model: run.agent.model, runId: run.id, event: run.status, error: run.error })))); });

  const worker = program.command("worker").description("Find workers across repositories and Relay restarts.");
  worker.command("list").description("List workers in the machine-global registry.")
    .option("--all", "include workers whose workspace was cleaned")
    .option("--repository <id>", "limit results to a normalized repository id")
    .option("--json", "emit JSON")
    .action(async (flags: { all?: boolean; repository?: string; json?: boolean }) => {
      const registry = await openGlobalRegistry(cwd);
      try {
        const workers = registry.list({ includeCleaned: flags.all, repositoryId: flags.repository });
        if (flags.json) { print(JSON.stringify(workers, null, 2)); return; }
        if (workers.length === 0) { print("No workers recorded in the global registry."); return; }
        print(eventsTable(workers.map((entry) => ({
          project: entry.repository.id, timestamp: entry.updatedAt,
          level: entry.status === "failed" || entry.status === "cleanup_failed" ? "error" : "info",
          task: entry.issueKey, trigger: entry.triggerId, agent: entry.harness,
          runId: entry.id, event: entry.status, error: entry.cleanupError,
        }))));
      } finally { registry.close(); }
    });
  worker.command("show <issue>").description("Show the latest worker for an issue key from any checkout.")
    .option("--repository <id>", "disambiguate by normalized repository id")
    .option("--source <id>", "disambiguate by source id")
    .option("--all", "include workers whose workspace was cleaned")
    .option("--json", "emit JSON")
    .action(async (issue: string, flags: { repository?: string; source?: string; all?: boolean; json?: boolean }) => {
      const registry = await openGlobalRegistry(cwd);
      try {
        const result = registry.lookupByIssueKey({ issueKey: issue, repositoryId: flags.repository, sourceId: flags.source, includeCleaned: flags.all });
        if (result.kind === "not_found") throw new Error(`No worker found for issue '${issue}'.`);
        if (result.kind === "ambiguous") {
          const choices = [...new Set(result.workers.map((entry) => `${entry.repository.id} (${entry.sourceId})`))];
          throw new Error(`Issue '${issue}' exists in more than one repository or source: ${choices.join(", ")}. Use --repository or --source.`);
        }
        if (flags.json) print(JSON.stringify(result.worker, null, 2)); else print(workerSummary(result.worker));
      } finally { registry.close(); }
    });

  program.command("logs").description("Read structured JSONL events.").option("--follow", "follow new events").option("--level <level>", "exact log level").option("--task <task>", "task identifier").option("--run <id>", "run id").option("--json", "emit JSON instead of a table").action(async (flags: { follow?: boolean; level?: string; task?: string; run?: string; json?: boolean }) => {
    const context = await resolveContext(cwd, print); const filtered = () => readEvents(context.projectRoot).filter((event) => (!flags.level || event.level === flags.level) && (!flags.task || event.task === flags.task) && (!flags.run || event.runId === flags.run));
    let seen = 0;
    const render = (incremental = false) => {
      const all = filtered(); const events = incremental ? all.slice(seen) : all; seen = all.length;
      if (!events.length && incremental) return;
      print(flags.json ? JSON.stringify(events, null, 2) : flags.level === "error" ? errorTable(events) : eventsTable(events));
    };
    render(); if (flags.follow) { const path = eventLogPath(context.projectRoot); if (!existsSync(path)) createEventLogger(context.projectRoot, context.config.logging.level); watch(path, { persistent: true }, () => render(true)); await new Promise<void>(() => undefined); }
  });

  const trigger = program.command("trigger").description("Inspect and exercise trigger mappings.");
  trigger.command("test <id>").description("Preview matching tasks without making changes.").action(async (id) => { const context = await resolveContext(cwd, print); const selected = context.config.triggers.find((entry) => entry.id === id); if (!selected) throw new Error(`Unknown trigger '${id}'.`); if (!options.handlers?.triggerTest) noHandler("trigger test"); await options.handlers.triggerTest(context, selected); });
  program.command("once").description("Process one source poll.").option("--trigger <id>").option("--task <id>").action(async (flags) => { const context = await resolveContext(cwd, print); if (!options.handlers?.once) noHandler("once"); await options.handlers.once(context, flags); });
  program.command("watch").description("Run continuous polling in the foreground.").option("--trigger <id>").action(async (flags) => { const context = await resolveContext(cwd, print); if (!options.handlers?.watch) noHandler("watch"); await options.handlers.watch(context, flags); });
  program.command("update [version]").description("Check for or install a Task Relay CLI update.").option("--check", "check without installing").action(async (version: string | undefined, flags: { check?: boolean }) => { if (!options.handlers?.update) noHandler("update"); print(await options.handlers.update({ check: flags.check, version: version ?? "latest" })); });
  program.command("attach <task-or-run>").description("Attach to an interactive tmux worker.").action(async (target: string) => { const context = await resolveWorkerContext(cwd, print, target); if (!options.handlers?.attach) noHandler("attach"); await options.handlers.attach(context, target); });
  program.command("cleanup <task-or-run>").description("Stop a worker and remove its isolated workspace.").action(async (target: string) => { const context = await resolveWorkerContext(cwd, print, target); if (!options.handlers?.cleanup) noHandler("cleanup"); await options.handlers.cleanup(context, target); });
  program.command("signal <task-or-worker> <outcome>")
    .description("Report a worker's own result so a workflow job can finish. Outcome is 'done' or 'failed'.")
    .option("--output <key=value>", "record an output for later jobs (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--message <text>", "human-readable note stored with the result")
    .action(async (target: string, outcome: string, flags: { output: string[]; message?: string }) => {
      if (outcome !== "done" && outcome !== "failed") throw new Error(`Outcome must be 'done' or 'failed', not '${outcome}'.`);
      const outputs: Record<string, string> = {};
      for (const entry of flags.output) {
        const separator = entry.indexOf("=");
        if (separator <= 0) throw new Error(`--output must be key=value, not '${entry}'.`);
        outputs[entry.slice(0, separator)] = entry.slice(separator + 1);
      }
      const context = await resolveContext(cwd, print);
      if (!options.handlers?.signal) noHandler("signal");
      await options.handlers.signal(context, target, outcome, { outputs, message: flags.message });
    });
  const config = program.command("config").description("Inspect and describe this repository's configuration.");
  config.command("schema")
    .description(`Emit a JSON Schema for ${CONFIG_FILE}, for editor completion and validation.`)
    .option("--write [path]", `write the schema to a file (default .task-relay.schema.json) and print the ${CONFIG_FILE} header to add`)
    .action(async (flags: { write?: string | boolean }) => {
      const { relayJsonSchema, schemaDirective } = await import("../config/json-schema.js");
      const schema = relayJsonSchema();
      if (!flags.write) { print(JSON.stringify(schema, null, 2)); return; }
      const root = await findProjectRoot(cwd());
      const relative = typeof flags.write === "string" ? flags.write : ".task-relay.schema.json";
      await writeFile(resolve(root, relative), `${JSON.stringify(schema, null, 2)}\n`);
      print(`Wrote ${resolve(root, relative)}`);
      print(`Add this as the first line of ${CONFIG_FILE} for completion in your editor:`);
      print(`  ${schemaDirective(`./${relative}`)}`);
    });

  const workflow = program.command("workflow").description("Inspect workflow runs and their job graphs.");
  workflow.command("inspect <id> <task>").description("Inspect inputs, outputs, attempts and dependency wait reasons.")
    .option("--occurrence <name>", "inspect one occurrence")
    .action(async (id: string, task: string, flags: { occurrence?: string }) => {
      const context = await resolveContext(cwd, print);
      const repository = { id: context.config.project.name || resolve(context.projectRoot).split("/").pop() || "project", root: context.projectRoot };
      const run = (await context.store.listWorkflowRuns(repository)).filter((run) => run.identity.workflowId === id && run.identity.itemId.toLowerCase() === task.toLowerCase() && (!flags.occurrence || flags.occurrence === run.identity.occurrence)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (!run) throw new Error(`No workflow '${id}' found for '${task}'.`);
      print(JSON.stringify(inspectWorkflowRun(run), null, 2));
    });
  workflow.command("test <id>").description("Preview a workflow's items, jobs, and what would start now.").action(async (id: string) => {
    const context = await resolveContext(cwd, print);
    if (!context.config.workflows[id]) throw new Error(`Unknown workflow '${id}'.`);
    if (!options.handlers?.workflowTest) noHandler("workflow test");
    await options.handlers.workflowTest(context, id);
  });
  workflow.command("adopt <id> <task>").description("Adopt the validated current definition for an imported workflow run.")
    .option("--occurrence <name>", "target a specific run; defaults to the most recent")
    .action(async (id: string, task: string, flags: { occurrence?: string }) => {
      const context = await resolveContext(cwd, print);
      if (!options.handlers?.workflowAdopt) noHandler("workflow adoption");
      await options.handlers.workflowAdopt(context, id, task, flags.occurrence);
    });
  workflow.command("retry <id> <task>")
    .description("Clear settled jobs so a workflow run advances again on the next poll.")
    .option("--job <name>", "retry only this job (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--occurrence <name>", "target a specific run; defaults to the most recent")
    .action(async (id: string, task: string, flags: { job: string[]; occurrence?: string }) => {
      const context = await resolveContext(cwd, print);
      const repository = { id: context.config.project.name || resolve(context.projectRoot).split("/").pop() || "project", root: context.projectRoot };
      const runs = (await context.store.listWorkflowRuns(repository))
        .filter((run) => run.identity.workflowId === id && run.identity.itemId.toLowerCase() === task.toLowerCase())
        .filter((run) => !flags.occurrence || run.identity.occurrence === flags.occurrence)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      if (runs.length === 0) throw new Error(`No run of workflow '${id}' found for '${task}'.`);
      const target = runs[0];
      const updated = await context.store.retryWorkflowJobs(target.identity, flags.job, new Date().toISOString());
      if (!updated) throw new Error(`Run ${target.identity.occurrence} of '${id}' could not be retried.`);
      const reset = Object.entries(updated.jobs).filter(([, job]) => job.status === "pending").map(([name]) => name);
      print(`Retrying ${id} for ${target.identity.itemId} (${target.identity.occurrence}).`);
      print(reset.length ? `  pending: ${reset.join(", ")}` : "  nothing was settled; the run was reopened.");
      print(`Run 'relay once --trigger ${id}' or wait for the next poll.`);
    });

  workflow.command("runs").description("Show persisted workflow runs and each job's state.").option("--json", "emit JSON").action(async (flags: { json?: boolean }) => {
    const context = await resolveContext(cwd, print);
    const runs = await context.store.listWorkflowRuns({ id: context.config.project.name || resolve(context.projectRoot).split("/").pop() || "project", root: context.projectRoot });
    if (flags.json) { print(JSON.stringify(redactExecution(runs), null, 2)); return; }
    if (runs.length === 0) { print("No workflow runs recorded."); return; }
    for (const run of runs) {
      print(`${run.identity.workflowId}  ${run.item.id}  ${run.status}  (${run.identity.occurrence})`);
      for (const [jobId, job] of Object.entries(run.jobs)) {
        print(`    ${jobId.padEnd(20)} ${job.status.padEnd(10)} ${job.needsAttention ? "needs attention: " : ""}${job.message || job.error || ""}`);
      }
    }
  });
  const daemon = program.command("daemon").description("Control the registered background runtime.");
  for (const action of ["start", "stop", "status"] as const) daemon.command(action).action(async () => { const context = await resolveContext(cwd, print); if (!options.handlers?.daemon) noHandler(`daemon ${action}`); await options.handlers.daemon(context, action); });

  program.command("dashboard").description("Open the global workflow canvas and local runtime control plane.")
    .option("--port <port>", "port to listen on", "3001")
    .option("--repo <paths...>", "register one or more repository folders before opening")
    .option("--no-open", "do not open the browser automatically")
    .action(async (flags: { port?: string; open?: boolean; repo?: string[] }) => {
      const [{ GlobalDashboardServer }, { ProjectManager }] = await Promise.all([
        import("../dashboard/global-server.js"),
        import("../dashboard/project-manager.js"),
      ]);
      const projects = new ProjectManager();
      for (const root of flags.repo ?? []) await projects.register(root);
      // Opening from a configured repository makes it visible immediately;
      // opening from any other folder still shows the persisted global list.
      try { await projects.register(cwd()); } catch { /* global dashboard works outside a repository */ }
      const server = new GlobalDashboardServer(projects, options.handlers ?? {});
      const port = flags.port ? Number(flags.port) : 3001;
      const url = await server.start(port);
      print(`Dashboard running at ${url}  (Ctrl-C to stop)`);
      if (flags.open !== false) {
        const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        const { execa } = await import("execa");
        await execa(open, [url], { reject: false });
      }
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await server.stop();
      projects.close();
    });

  addPluginCommands(program, print);

  program.configureOutput({ writeOut: (text) => output.write(text), writeErr: (text) => error.write(text) });
  return program;
}
