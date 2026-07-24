import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LinearPiOrchestrator } from "./core/orchestrator.ts";
import { PiUIProvider } from "./providers/pi-ui.ts";
import { PiMcpLinearClient } from "./providers/mcp-linear-pi.ts";
import {
  readConfig, writeConfig, resolveRepoRoot, AGENT_PRESETS,
  setTriggerLabel, setAgent, readWatchBarPreference, writeWatchBarPreference,
} from "./core/config.ts";

const WATCH_STATUS_KEY = "linear-watch";
const WATCH_BAR_INTERVAL_MS = 30_000;

function parseLinearSaveIssueInputId(event: any): string | undefined {
  const args = typeof event?.input?.args === "string"
    ? safeJsonParse(event.input.args)
    : event?.input?.args;
  return typeof args?.id === "string" && args.id.trim() ? args.id.trim() : undefined;
}

function extractLinearIssueFromToolResult(event: any): any | undefined {
  const text = firstTextContent(event?.details?.mcpResult?.content)
    || firstTextContent(event?.content);
  return safeJsonParse(text);
}

function firstTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find((p: any) => p?.type === "text" && typeof p.text === "string")?.text;
}

function safeJsonParse(value: unknown): any | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

export default function linearPiOrchestratorExtension(pi: ExtensionAPI) {
  const ui = new PiUIProvider();
  const linear = new PiMcpLinearClient();
  const orchestrator = new LinearPiOrchestrator(ui, linear);

  let watchBarTimer: NodeJS.Timeout | undefined;
  let watchBarEnabled = true;

  // Path to cli.ts so the orchestrator can spawn it as the daemon process
  const extensionFile = fileURLToPath(import.meta.url);
  const daemonEntry = path.join(path.dirname(extensionFile), "cli.ts");

  function configForContext(ctx: ExtensionContext) {
    const repoRoot = resolveRepoRoot(ctx.cwd);
    const config = readConfig(repoRoot);
    if (repoRoot && config.repoRoot !== repoRoot) {
      config.repoRoot = repoRoot;
      writeConfig(config);
    }
    linear.setRepoRoot(config.repoRoot);
    return config;
  }

  function refreshWatchBar(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const config = configForContext(ctx);
    watchBarEnabled = readWatchBarPreference(config.repoRoot) ?? true;
    if (!watchBarEnabled) {
      ctx.ui.setStatus(WATCH_STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(WATCH_STATUS_KEY, orchestrator.statusBarText(config));
  }

  function startWatchBar(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (watchBarTimer) clearInterval(watchBarTimer);
    refreshWatchBar(ctx);
    watchBarTimer = setInterval(() => refreshWatchBar(ctx), WATCH_BAR_INTERVAL_MS);
  }

  function stopWatchBar(ctx?: ExtensionContext) {
    if (watchBarTimer) clearInterval(watchBarTimer);
    watchBarTimer = undefined;
    if (ctx?.hasUI) ctx.ui.setStatus(WATCH_STATUS_KEY, undefined);
  }

  async function setWatchBarEnabled(ctx: ExtensionContext, enabled: boolean) {
    const config = configForContext(ctx);
    watchBarEnabled = enabled;
    const saved = writeWatchBarPreference(enabled, config.repoRoot);
    if (!saved) ctx.ui.notify("Could not save Linear watch bar preference", "warning");
    if (enabled) {
      startWatchBar(ctx);
      ctx.ui.notify(`Linear watch bar enabled: ${orchestrator.statusBarText(config)}`, "info");
    } else {
      stopWatchBar(ctx);
      ctx.ui.notify("Linear watch bar disabled", "info");
    }
  }

  // ── Lifecycle events ────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ui.setContext(ctx);
    const config = configForContext(ctx);
    watchBarEnabled = readWatchBarPreference(config.repoRoot) ?? true;
    if (watchBarEnabled) startWatchBar(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWatchBar();
    await orchestrator.shutdown();
  });

  // Auto-cleanup when an agent calls linear.save_issue and marks an issue done
  pi.on("tool_result", async (event, ctx) => {
    const details = event.details as any;
    if (
      event.isError
      || event.toolName !== "mcp"
      || details?.mode !== "call"
      || details?.server !== "linear"
      || details?.tool !== "save_issue"
    ) return;

    ui.setContext(ctx);
    const inputId = parseLinearSaveIssueInputId(event);
    if (!inputId) return;

    const config = configForContext(ctx);
    const savedIssue = extractLinearIssueFromToolResult(event);
    const result = await orchestrator.cleanupIfIssueDone(inputId, config, savedIssue).catch((error) => {
      orchestrator.logMessage(config, `save_issue for ${inputId}: auto-cleanup failed - ${error instanceof Error ? error.message : String(error)}`, "warning");
      return undefined;
    });
    if (result) {
      orchestrator.logMessage(config, `save_issue for ${inputId}: auto-cleaned worker - ${result}`);
      ctx.ui.notify(`Linear issue is done; cleaned worker automatically.\n${result}`, "info");
      refreshWatchBar(ctx);
    }
  });

  // ── Commands ────────────────────────────────────────────────────────────────

  pi.registerCommand("linear-start", {
    description: "Start a tmux/Pi worker for a Linear issue. Usage: /linear-start ABC-123",
    handler: async (args, ctx) => {
      ui.setContext(ctx);
      const issueId = args.trim();
      if (!issueId) { ctx.ui.notify("Usage: /linear-start ABC-123", "error"); return; }
      ctx.ui.notify(`Starting Linear Pi worker for ${issueId}...`, "info");
      const config = configForContext(ctx);
      const worker = await orchestrator.startIssue(issueId, config);
      ctx.ui.notify(`Started ${worker.identifier}: ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}`, "info");
    },
  });

  pi.registerCommand("linear-watch", {
    description: "Manage Linear label watcher. Usage: /linear-watch start [label] | foreground [label] | once [label] | model [pi|claude|codex|opencode] | stop | status | logs",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.split(/\s+/);
      if (tokens.length > 1 && (tokens[0] === "model" || tokens[0] === "agent")) {
        const last = tokens[tokens.length - 1];
        return Object.keys(AGENT_PRESETS).filter((x) => x.startsWith(last)).map((v) => ({ value: `${tokens[0]} ${v}`, label: v }));
      }
      return ["start", "foreground", "stop", "once", "model", "status", "logs"].filter((x) => x.startsWith(prefix)).map((v) => ({ value: v, label: v }));
    },
    handler: async (args, ctx) => {
      ui.setContext(ctx);
      const [action = "status", maybeLabel] = args.trim().split(/\s+/).filter(Boolean);
      const config = configForContext(ctx);

      if (action === "start") {
        if (process.env.LINEAR_PI_WORKER === "1") {
          ctx.ui.notify("Refusing to start watcher in a spawned worker session.", "warning");
          return;
        }
        if (maybeLabel) setTriggerLabel(maybeLabel, config.repoRoot);
        ctx.ui.notify(orchestrator.startDaemon(daemonEntry, readConfig(config.repoRoot)), "info");
        refreshWatchBar(ctx);
        return;
      }

      if (action === "foreground") {
        orchestrator.startWatch(config, maybeLabel);
        ctx.ui.notify(orchestrator.statusSummary(readConfig(config.repoRoot)), "info");
        refreshWatchBar(ctx);
        return;
      }

      if (action === "stop") {
        const daemonMessage = orchestrator.stopDaemon(config);
        orchestrator.stopWatch();
        ctx.ui.notify(daemonMessage || "Linear watcher stopped.", "info");
        refreshWatchBar(ctx);
        return;
      }

      if (action === "once") {
        ctx.ui.notify(await orchestrator.watchOnce(config, maybeLabel), "info");
        return;
      }

      if (action === "model" || action === "agent") {
        if (maybeLabel) {
          if (!AGENT_PRESETS[maybeLabel.toLowerCase()]) {
            ctx.ui.notify(`Unknown agent "${maybeLabel}". Available: ${Object.keys(AGENT_PRESETS).join(", ")}.`, "error");
            return;
          }
          const updated = setAgent(maybeLabel, config.repoRoot);
          ctx.ui.notify(`Agent set to ${updated.agent}. Restart daemon to pick it up.`, "info");
          return;
        }
        await orchestrator.selectAgent(config);
        return;
      }

      if (action === "logs") {
        ctx.ui.notify(orchestrator.getLogs(config), "info");
        return;
      }

      ctx.ui.notify(orchestrator.statusSummary(config, true), "info");
    },
  });

  pi.registerCommand("linear-watch-bar", {
    description: "Show or hide Linear watcher status in the footer. Usage: /linear-watch-bar [on|off|toggle|status|refresh]",
    getArgumentCompletions: (prefix) => ["on", "off", "toggle", "status", "refresh"].filter((x) => x.startsWith(prefix)).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      ui.setContext(ctx);
      const action = args.trim().toLowerCase() || "refresh";
      if (["on", "enable", "enabled"].includes(action)) { await setWatchBarEnabled(ctx, true); return; }
      if (["off", "disable", "disabled"].includes(action)) { await setWatchBarEnabled(ctx, false); return; }
      if (action === "toggle") { await setWatchBarEnabled(ctx, !watchBarEnabled); return; }
      if (action === "status") {
        refreshWatchBar(ctx);
        const config = configForContext(ctx);
        ctx.ui.notify(`Linear watch bar: ${watchBarEnabled ? "enabled" : "disabled"}\n${orchestrator.statusBarText(config)}`, "info");
        return;
      }
      refreshWatchBar(ctx);
      if (action !== "refresh") ctx.ui.notify("Usage: /linear-watch-bar [on|off|toggle|status|refresh]", "warning");
      else ctx.ui.notify(orchestrator.statusBarText(configForContext(ctx)), "info");
    },
  });

  pi.registerCommand("linear-cleanup", {
    description: "Clean tmux windows and wt worktrees. Usage: /linear-cleanup [done|all|CRM-123]",
    getArgumentCompletions: (prefix) => {
      const workers = orchestrator.listWorkers(undefined, readConfig(process.cwd()));
      return ["done", "all", ...workers.map((w) => w.identifier), ...workers.map((w) => w.branch)]
        .filter((x) => x.startsWith(prefix))
        .map((v) => ({ value: v, label: v }));
    },
    handler: async (args, ctx) => {
      ui.setContext(ctx);
      const config = configForContext(ctx);
      const target = args.trim();
      if (!target) {
        ctx.ui.notify(await orchestrator.cleanupInteractive(config), "info");
        return;
      }
      ctx.ui.notify(`Cleaning Linear Pi workers: ${target}...`, "info");
      ctx.ui.notify(await orchestrator.cleanup(target, config), "info");
    },
  });

  pi.registerCommand("linear-status", {
    description: "Show Linear Pi worker state",
    handler: async (_args, ctx) => {
      ui.setContext(ctx);
      const config = configForContext(ctx);
      const workers = orchestrator.listWorkers(undefined, config);
      if (!workers.length) { ctx.ui.notify("No Linear Pi workers recorded.", "info"); return; }
      const text = workers
        .map((w) => `${w.identifier} [${w.status}]\n- tmux: ${w.tmuxSession}:${w.tmuxWindowIndex || "?"}:${w.tmuxWindow}\n- branch: ${w.branch}\n- worktree: ${w.worktree}${w.error ? `\n- error: ${w.error}` : ""}`)
        .join("\n\n");
      ctx.ui.notify(text, "info");
    },
  });
}
