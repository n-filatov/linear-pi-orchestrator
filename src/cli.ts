#!/usr/bin/env node
import * as fs from "node:fs";
import { Command } from "commander";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { LinearPiOrchestrator } from "./core/orchestrator.ts";
import { CliUIProvider } from "./providers/cli-ui.ts";
import { renderWorkerTable } from "./core/render.ts";
import { SdkMcpLinearClient } from "./providers/mcp-linear-sdk.ts";
import {
  readConfig, writeConfig, resolveRepoRoot, AGENT_PRESETS,
  setTriggerLabel, setAgent, logPath, pidPath, repoScopeDir,
} from "./core/config.ts";
import { isDaemonRunning } from "./core/state.ts";
import {
  readCachedUpdateAvailable, checkForUpdateBackground, performUpdate, versionString,
} from "./core/updater.ts";

// ── Daemon mode (spawned by startDaemon) ──────────────────────────────────────

if (process.argv.includes("--daemon")) {
  runDaemon().catch((error) => {
    const config = readConfig(process.env.LINEAR_PI_REPO_ROOT || process.cwd());
    fs.appendFileSync(
      logPath(config.repoRoot),
      `${new Date().toISOString()} ERROR Daemon failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exit(1);
  });
} else {
  runCli();
}

// ── Daemon entry ──────────────────────────────────────────────────────────────

async function runDaemon() {
  const config = readConfig(process.env.LINEAR_PI_REPO_ROOT || process.cwd());
  fs.mkdirSync(repoScopeDir(config.repoRoot), { recursive: true });
  fs.writeFileSync(pidPath(config.repoRoot), String(process.pid));

  const ui = new CliUIProvider();
  const linear = new SdkMcpLinearClient({ interactive: false });
  const orchestrator = new LinearPiOrchestrator(ui, linear);

  const cleanup = async () => {
    fs.rmSync(pidPath(config.repoRoot), { force: true });
    await orchestrator.shutdown();
  };
  process.once("SIGTERM", () => void cleanup().finally(() => process.exit(0)));
  process.once("SIGINT", () => void cleanup().finally(() => process.exit(0)));

  orchestrator.startWatch(config);
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

function runCli() {
  const ui = new CliUIProvider();
  const linear = new SdkMcpLinearClient();
  const orchestrator = new LinearPiOrchestrator(ui, linear);

  // Background update check (once per 24h, no await — never blocks commands)
  void checkForUpdateBackground();

  // Show update notice at the very end so it doesn't interrupt command output
  if (readCachedUpdateAvailable()) {
    process.on("exit", () => {
      process.stderr.write(
        "\nA new version of linear-pi is available. Run: linear-pi update\n",
      );
    });
  }

  function resolveConfig(cwd?: string) {
    const repoRoot = resolveRepoRoot(cwd ?? process.cwd()) ?? process.cwd();
    const config = readConfig(repoRoot);
    if (config.repoRoot !== repoRoot) { config.repoRoot = repoRoot; writeConfig(config); }
    return config;
  }

  const program = new Command("linear-pi")
    .description("Linear Pi Orchestrator — start AI workers for Linear issues via Linear MCP")
    .option("-C, --cwd <dir>", "Repository root (defaults to git root of current directory)")
    .version(versionString());

  // ── linear-pi start <issueId> ─────────────────────────────────────────────

  program
    .command("start <issueId>")
    .description("Start a tmux worker for a Linear issue")
    .action(async (issueId: string) => {
      const config = resolveConfig(program.opts().cwd);
      ui.notify(`Starting worker for ${issueId}...`);
      const worker = await orchestrator.startIssue(issueId.trim(), config);
      ui.notify(`Started ${worker.identifier}: ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}`);
    });

  // ── linear-pi watch ───────────────────────────────────────────────────────

  const watch = program
    .command("watch")
    .description("Manage the background watcher daemon");

  watch
    .command("start [label]")
    .description("Start the background daemon watcher (detached)")
    .option("--model <agent>", "Agent to use: pi, claude, codex, opencode")
    .action(async (label?: string, opts?: { model?: string }) => {
      if (process.env.LINEAR_PI_WORKER === "1") {
        ui.notify("Refusing to start watcher in a worker session.", "warning");
        return;
      }
      const config = resolveConfig(program.opts().cwd);
      if (label) setTriggerLabel(label, config.repoRoot);
      if (opts?.model) setAgent(opts.model, config.repoRoot);
      const daemonEntry = process.argv[1]; // this file
      ui.notify(orchestrator.startDaemon(daemonEntry, readConfig(config.repoRoot)));
    });

  watch
    .command("foreground [label]")
    .description("Run watcher in the foreground (blocking)")
    .action(async (label?: string) => {
      const config = resolveConfig(program.opts().cwd);
      orchestrator.startWatch(config, label);
      ui.notify(orchestrator.statusSummary(readConfig(config.repoRoot)));

      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      orchestrator.stopWatch();
      await orchestrator.shutdown();
    });

  watch
    .command("stop")
    .description("Stop the background daemon and foreground watcher")
    .action(() => {
      const config = resolveConfig(program.opts().cwd);
      const msg = orchestrator.stopDaemon(config);
      orchestrator.stopWatch();
      ui.notify(msg || "Watcher stopped.");
    });

  watch
    .command("once [label]")
    .description("Run one poll tick")
    .action(async (label?: string) => {
      const config = resolveConfig(program.opts().cwd);
      ui.notify(await orchestrator.watchOnce(config, label));
      await orchestrator.shutdown();
    });

  watch
    .command("status")
    .description("Show watcher status and recent logs")
    .action(() => {
      const config = resolveConfig(program.opts().cwd);
      ui.notify(orchestrator.statusSummary(config, true));
    });

  watch
    .command("logs")
    .description("Show recent watcher logs")
    .action(() => {
      const config = resolveConfig(program.opts().cwd);
      ui.notify(orchestrator.getLogs(config));
    });

  watch
    .command("model [agent]")
    .description("Set worker agent: pi, claude, codex, opencode")
    .action(async (agent?: string) => {
      const config = resolveConfig(program.opts().cwd);
      if (agent) {
        if (!AGENT_PRESETS[agent.toLowerCase()]) {
          ui.notify(`Unknown agent "${agent}". Available: ${Object.keys(AGENT_PRESETS).join(", ")}.`, "error");
          process.exit(1);
        }
        const updated = setAgent(agent, config.repoRoot);
        ui.notify(`Agent set to ${updated.agent}. Restart daemon to pick it up.`);
      } else {
        await orchestrator.selectAgent(config);
      }
    });

  // ── linear-pi cleanup ─────────────────────────────────────────────────────

  program
    .command("cleanup [target]")
    .description("Clean workers. target: done | all | <issue-id> (interactive picker if omitted)")
    .action(async (target?: string) => {
      const config = resolveConfig(program.opts().cwd);
      if (!target) {
        ui.notify(await orchestrator.cleanupInteractive(config));
      } else {
        ui.notify(`Cleaning workers: ${target}...`);
        ui.notify(await orchestrator.cleanup(target, config));
      }
      await orchestrator.shutdown();
    });

  // ── linear-pi status ──────────────────────────────────────────────────────

  program
    .command("status")
    .description("Show recorded workers")
    .action(() => {
      const config = resolveConfig(program.opts().cwd);
      const workers = orchestrator.listWorkers(undefined, config);
      if (!workers.length) { ui.notify("No Linear Pi workers recorded."); return; }
      ui.notify(renderWorkerTable(workers));
    });

  // ── linear-pi auth ────────────────────────────────────────────────────────

  const auth = program
    .command("auth")
    .description("Manage Linear authentication");

  auth
    .command("login", { isDefault: true })
    .description(
      "Authenticate with Linear. On a machine with a browser this opens it automatically; " +
      "on a headless/VPS box it prints a URL to open elsewhere and lets you paste the callback URL back.",
    )
    .option("--force", "Re-authenticate even if already logged in")
    .action(async (opts: { force?: boolean }) => {
      resolveConfig(program.opts().cwd);
      const result = await linear.login({ force: opts.force });
      ui.notify(
        result === "already-authenticated"
          ? "Already authenticated with Linear. Use --force to re-authenticate."
          : "Linear authentication complete.",
      );
      await orchestrator.shutdown();
    });

  auth
    .command("logout")
    .description("Remove stored Linear credentials")
    .action(() => {
      linear.logout();
      ui.notify("Linear credentials removed. Run `linear-pi auth login` to re-authenticate.");
    });

  auth
    .command("status")
    .description("Check whether linear-pi has usable Linear credentials stored")
    .action(() => {
      const authed = linear.checkAuth();
      const info = linear.tokenInfo();
      const lines = [authed ? "Authenticated with Linear." : "Not authenticated with Linear."];
      if (info?.expiresAt) {
        const expiry = new Date(info.expiresAt * 1000).toLocaleString();
        lines.push(
          info.refreshToken
            ? `Access token expires: ${expiry} (will auto-refresh silently, no action needed).`
            : `Access token expires: ${expiry} (no refresh token stored — you'll need to run \`linear-pi auth login\` again after this).`,
        );
      }
      if (!authed) lines.push("Run `linear-pi auth login` to authenticate.");
      ui.notify(lines.join("\n"));
    });

  // ── linear-pi update ─────────────────────────────────────────────────────

  program
    .command("update")
    .description("Download and replace this binary with the latest release from GitHub")
    .action(async () => {
      await performUpdate();
    });

  program.parseAsync(process.argv).catch((error) => {
    if (error instanceof UnauthorizedError) {
      ui.notify("Not authorized with Linear. Run `linear-pi auth login` to authenticate.", "error");
    } else {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    process.exit(1);
  });
}
