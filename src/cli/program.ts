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
import { writeFile } from "node:fs/promises";

export type RelayCommandContext = { projectRoot: string; config: RelayConfigV2; store: RepositoryStateStore; logger: ReturnType<typeof createEventLogger>; write: (value: string) => void };
export type RelayCommandHandlers = {
  once?: (context: RelayCommandContext, options: { trigger?: string; task?: string }) => Promise<void>;
  watch?: (context: RelayCommandContext, options: { trigger?: string }) => Promise<void>;
  daemon?: (context: RelayCommandContext, action: "start" | "stop" | "status") => Promise<void>;
  triggerTest?: (context: RelayCommandContext, trigger: RelayTriggerV2) => Promise<void>;
  cleanup?: (context: RelayCommandContext, target: string) => Promise<void>;
  attach?: (context: RelayCommandContext, target: string) => Promise<void>;
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
        with: { activeWorker: "stop" },
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
      {
        id: `${options.source}-cleanup-terminal`,
        source: options.source,
        match: { statusTypes: ["completed", "canceled"] },
        targets: { workers: { sourceItem: "current", runs: "all" } },
        actions: [cleanupActionId],
        fire: { policy: "once-per-item" },
      },
    ],
    workspace: { adapter: "wt", directory: ".task-relay/workspaces", baseBranch: branch, branchPrefix: "relay" },
    execution: { maxConcurrent: options.maxConcurrent, retries: 2, adapter: "tmux", tmuxSession: `task-relay-${projectName.replace(/[^a-zA-Z0-9_.-]+/g, "-")}` },
    logging: { level: "info", pretty: true },
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

  program.command("doctor").description("Check repository configuration and required local executables.").action(async () => {
    const root = await findProjectRoot(cwd()); let configuration = "missing";
    try { await loadRelayConfig(root); configuration = "valid"; } catch (cause) { configuration = cause instanceof Error ? cause.message : "invalid"; }
    print(statusTable([["Project root", root], ["Configuration", configuration], ...harnessAvailabilityRows(), ["wt", executable("wt") ? "available" : "not found"], ["tmux", executable("tmux") ? "available" : "not found"], ["State directory", stateDirectory(root)]]));
  });

  program.command("status").description("Show repository relay state.").action(async () => { const context = await resolveContext(cwd, print); const runs = await context.store.listRuns(); print(statusTable([["Project", context.config.project.name || context.projectRoot], ["Sources", Object.keys(context.config.sources).length], ["Harnesses", Object.keys(context.config.harnesses).length], ["Actions", Object.keys(context.config.actions).length], ["Triggers", context.config.triggers.filter((trigger) => trigger.enabled).length], ["Active runs", runs.filter((run) => ["claimed", "provisioning", "launching", "running"].includes(run.status)).length], ["State", context.store.file], ["Log", eventLogPath(context.projectRoot)]])); });

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
  program.command("update [version]").description("Check for or install a Task Relay CLI update.").option("--check", "check without installing").action(async (version: string | undefined, flags: { check?: boolean }) => { if (!options.handlers?.update) noHandler("update"); print(await options.handlers.update({ check: flags.check, version: version ?? "latest" })); });
  program.command("attach <task-or-run>").description("Attach to an interactive tmux worker.").action(async (target: string) => { const context = await resolveContext(cwd, print); if (!options.handlers?.attach) noHandler("attach"); await options.handlers.attach(context, target); });
  program.command("cleanup <task-or-run>").description("Stop a worker and remove its isolated workspace.").action(async (target: string) => { const context = await resolveContext(cwd, print); if (!options.handlers?.cleanup) noHandler("cleanup"); await options.handlers.cleanup(context, target); });
  const daemon = program.command("daemon").description("Control the registered background runtime.");
  for (const action of ["start", "stop", "status"] as const) daemon.command(action).action(async () => { const context = await resolveContext(cwd, print); if (!options.handlers?.daemon) noHandler(`daemon ${action}`); await options.handlers.daemon(context, action); });

  program.configureOutput({ writeOut: (text) => output.write(text), writeErr: (text) => error.write(text) });
  return program;
}
