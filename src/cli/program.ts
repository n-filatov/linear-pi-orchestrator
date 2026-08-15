import { execFileSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { Command } from "commander";
import { confirm, input, number, select } from "@inquirer/prompts";
import { resolve } from "node:path";
import { renderRelayConfig, findProjectRoot, loadRelayConfig, CONFIG_FILE, LOCAL_CONFIG_FILE } from "../config/load.js";
import { relayConfigSchema, type RelayConfig, type RelayTrigger } from "../config/schema.js";
import { createEventLogger, eventLogPath, logEvent, readEvents, stateDirectory } from "../logging/events.js";
import { errorTable, eventsTable, statusTable } from "../logging/tables.js";
import { RepositoryStateStore } from "../state/store.js";
import { writeFile } from "node:fs/promises";

export type RelayCommandContext = { projectRoot: string; config: RelayConfig; store: RepositoryStateStore; logger: ReturnType<typeof createEventLogger>; write: (value: string) => void };
export type RelayCommandHandlers = {
  once?: (context: RelayCommandContext, options: { trigger?: string; task?: string }) => Promise<void>;
  watch?: (context: RelayCommandContext, options: { trigger?: string }) => Promise<void>;
  daemon?: (context: RelayCommandContext, action: "start" | "stop" | "status") => Promise<void>;
  triggerTest?: (context: RelayCommandContext, trigger: RelayTrigger) => Promise<void>;
  cleanup?: (context: RelayCommandContext, target: string) => Promise<void>;
};
export type RelayCliOptions = { handlers?: RelayCommandHandlers; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream; cwd?: () => string };

type InitOptions = { source?: string; agent?: string; label?: string; model?: string; maxConcurrent?: number; yes?: boolean; force?: boolean; dryRun?: boolean };

function executable(command: string): boolean { try { execFileSync("which", [command], { stdio: "ignore" }); return true; } catch { return false; } }
function gitValue(root: string, args: string[]): string | undefined { try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim() || undefined; } catch { return undefined; } }
function defaultConfig(options: Required<Pick<InitOptions, "source" | "agent" | "label" | "maxConcurrent">> & Pick<InitOptions, "model">, projectName: string, branch: string): RelayConfig {
  const agentCommand = options.agent === "claude" ? "claude" : "codex";
  const agentArgs = options.agent === "claude" ? ["-p"] : ["exec"];
  const provider = options.agent === "claude" ? "anthropic" : "openai";
  return relayConfigSchema.parse({
    version: 1, project: { name: projectName },
    sources: { [options.source]: { type: "linear", enabled: true, pollIntervalMs: 30_000, mcp: { transport: "stdio", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], environment: {} }, reporting: { runningLabel: "relay:running", blockedLabel: "relay:blocked", doneLabel: "relay:done", inProgressState: "In Progress", commentOnLaunch: true, commentOnFailure: true } } },
    agents: { [options.agent]: { provider, command: agentCommand, args: agentArgs, environment: {}, models: ["selected"], defaultModelProfile: "selected", modelArgument: "--model", ...(options.agent === "claude" ? { reasoningEffortArgument: "--effort" } : {}), promptDelivery: { mode: "argument" } } },
    modelProfiles: { selected: { provider, ...(options.model ? { model: options.model } : {}), arguments: [] } },
    triggers: [{ id: `${options.source}-${options.label.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "tasks"}`, source: options.source, label: options.label, assignee: "me", match: { excludeLabels: ["relay:running", "relay:done", "relay:blocked"] }, agent: options.agent, model: "selected", enabled: true }],
    workspace: { adapter: "wt", directory: ".task-relay/workspaces", baseBranch: branch, branchPrefix: "relay" }, execution: { maxConcurrent: options.maxConcurrent, retries: 2, adapter: "tmux", tmuxSession: `task-relay-${projectName.replace(/[^a-zA-Z0-9_.-]+/g, "-")}` }, logging: { level: "info", pretty: true },
  });
}

async function resolveContext(cwd: () => string, write: (value: string) => void): Promise<RelayCommandContext> {
  const loaded = await loadRelayConfig(cwd());
  return { projectRoot: loaded.projectRoot, config: loaded.config, store: new RepositoryStateStore(loaded.projectRoot), logger: createEventLogger(loaded.projectRoot, loaded.config.logging.level, loaded.config.logging.pretty), write };
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
    .option("--source <name>", "source name", "linear").option("--agent <name>", "agent preset: codex or claude")
    .option("--label <label>", "source label to route").option("--model <profile>", "model profile and model name")
    .option("--max-concurrent <count>", "maximum simultaneous runs", (value) => Number(value)).option("--yes", "accept inferred defaults")
    .option("--force", "replace an existing config").option("--dry-run", "print config without writing")
    .action(async (init: InitOptions) => {
      const projectRoot = await findProjectRoot(cwd()); const target = resolve(projectRoot, CONFIG_FILE);
      if (existsSync(target) && !init.force) throw new Error(`${target} already exists. Use --force to replace it.`);
      const inferredAgent = init.agent || (executable("codex") ? "codex" : executable("claude") ? "claude" : "codex");
      const defaults = { source: init.source || "linear", agent: inferredAgent, label: init.label || "relay:implement", model: init.model, maxConcurrent: init.maxConcurrent || 2 };
      const answers = init.yes ? defaults : {
        source: await input({ message: "Source name", default: defaults.source }),
        agent: await select({ message: "Agent", default: defaults.agent, choices: [{ name: `Codex${executable("codex") ? " (found)" : " (not found)"}`, value: "codex" }, { name: `Claude${executable("claude") ? " (found)" : " (not found)"}`, value: "claude" }] }),
        label: await input({ message: "Trigger label", default: defaults.label }),
        model: (await input({ message: "Model ID (leave empty to use the agent default)", default: defaults.model || "" })).trim() || undefined,
        maxConcurrent: await number({ message: "Maximum concurrent runs", default: defaults.maxConcurrent, min: 1, max: 32 }),
      };
      const repoName = gitValue(projectRoot, ["config", "--get", "remote.origin.url"])?.split("/").pop()?.replace(/\.git$/, "") || resolve(projectRoot).split("/").pop() || "project";
      const remoteBranch = gitValue(projectRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])?.replace(/^origin\//, "");
      const branch = remoteBranch || gitValue(projectRoot, ["branch", "--show-current"]) || "main";
      const resolvedAnswers = { ...answers, maxConcurrent: answers.maxConcurrent ?? defaults.maxConcurrent };
      const config = defaultConfig(resolvedAnswers, repoName, branch); const document = `# Task Relay configuration. Safe to commit: do not put credentials here.\n# Personal machine-only changes belong in ${LOCAL_CONFIG_FILE}; keep it untracked and never store secrets in Relay YAML.\n${renderRelayConfig(config)}`;
      print(statusTable([["Repository", projectRoot], ["Project", repoName], ["Base branch", branch], ["Codex", executable("codex") ? "available" : "not found"], ["Claude", executable("claude") ? "available" : "not found"], ["wt", executable("wt") ? "available" : "not found"], ["tmux", executable("tmux") ? "available" : "not found"]]));
      if (!init.yes && !init.dryRun && !(await confirm({ message: `Write ${CONFIG_FILE}?`, default: true }))) return;
      if (init.dryRun) { print(document); return; }
      await writeFile(target, document); print(`Created ${target}`);
    });

  program.command("doctor").description("Check repository configuration and required local executables.").action(async () => {
    const root = await findProjectRoot(cwd()); let configuration = "missing";
    try { await loadRelayConfig(root); configuration = "valid"; } catch (cause) { configuration = cause instanceof Error ? cause.message : "invalid"; }
    print(statusTable([["Project root", root], ["Configuration", configuration], ["codex", executable("codex") ? "available" : "not found"], ["claude", executable("claude") ? "available" : "not found"], ["wt", executable("wt") ? "available" : "not found"], ["tmux", executable("tmux") ? "available" : "not found"], ["State directory", stateDirectory(root)]]));
  });

  program.command("status").description("Show repository relay state.").action(async () => { const context = await resolveContext(cwd, print); const runs = await context.store.listRuns(); print(statusTable([["Project", context.config.project.name || context.projectRoot], ["Triggers", context.config.triggers.filter((trigger) => trigger.enabled).length], ["Active runs", runs.filter((run) => ["claimed", "provisioning", "launching", "running"].includes(run.status)).length], ["State", context.store.file], ["Log", eventLogPath(context.projectRoot)]])); });

  program.command("runs").description("List persisted runs.").option("--json", "emit JSON").action(async (flags: { json?: boolean }) => { const context = await resolveContext(cwd, print); const runs = await context.store.listRuns(); if (flags.json) print(JSON.stringify(runs, null, 2)); else print(eventsTable(runs.map((run) => ({ project: context.config.project.name || context.projectRoot, timestamp: run.claimedAt, level: run.status === "failed" ? "error" : "info", task: run.item.id, trigger: run.trigger.id, agent: run.agent.agentId, model: run.agent.model, runId: run.id, event: run.status, error: run.error })))); });

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
  program.command("cleanup <task-or-run>").description("Stop a worker and remove its isolated workspace.").action(async (target: string) => { const context = await resolveContext(cwd, print); if (!options.handlers?.cleanup) noHandler("cleanup"); await options.handlers.cleanup(context, target); });
  const daemon = program.command("daemon").description("Control the registered background runtime.");
  for (const action of ["start", "stop", "status"] as const) daemon.command(action).action(async () => { const context = await resolveContext(cwd, print); if (!options.handlers?.daemon) noHandler(`daemon ${action}`); await options.handlers.daemon(context, action); });

  program.configureOutput({ writeOut: (text) => output.write(text), writeErr: (text) => error.write(text) });
  return program;
}
