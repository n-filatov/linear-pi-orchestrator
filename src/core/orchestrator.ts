import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { LinearIssue, WorkerState, WorkerPromptAttachment, Config } from "../types.ts";
import type { UIProvider } from "../providers/ui.ts";
import type { LinearClient } from "../providers/linear.ts";
import {
  readConfig, writeConfig, repoScopeDir, logPath, pidPath,
  resolveAgentPreset, AGENT_PRESETS, DEFAULT_AGENT, slugify, buildWindowName,
  setTriggerLabel, setAgent as setAgentConfig,
} from "./config.ts";
import {
  readState, writeState, withStateLock, readDaemonPid, isPidRunning,
  isDaemonRunning, removeRepoScopeDirIfUnused,
} from "./state.ts";
import { buildWorkerPrompt, extractMarkdownImageUrls, extensionForMimeType, extensionForAttachmentContent } from "./prompt.ts";
import { killTmuxWindow, killWorkerProcesses, verifyNoWorktreeProcesses, startTmuxWindow, renameTmuxWindow, resolveTmuxWindowTarget } from "./tmux.ts";
import { checkResourceCapacity } from "./resources.ts";
import { issueLabels, isIssueDoneOrCanceled } from "../types.ts";

const execFileAsync = promisify(execFile);

const WATCH_STATUS_KEY = "linear-watch";

export class LinearPiOrchestrator {
  private timer: NodeJS.Timeout | undefined;
  private runningOnce = false;
  private watchConfig: Config | undefined;
  private logs: string[] = [];
  private readonly ui: UIProvider;
  private readonly linear: LinearClient;

  constructor(ui: UIProvider, linear: LinearClient) {
    this.ui = ui;
    this.linear = linear;
  }

  // ── Logging ─────────────────────────────────────────────────────────────────

  private log(config: Config, message: string, level: "info" | "warning" | "error" = "info") {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    this.logs.push(line);
    this.logs = this.logs.slice(-50);
    try {
      fs.mkdirSync(repoScopeDir(config.repoRoot), { recursive: true });
      fs.appendFileSync(logPath(config.repoRoot), `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
    } catch {
      // Keep in-memory logging working even if file logging is unavailable.
    }
    this.ui.setStatus(WATCH_STATUS_KEY, level === "error" ? "Linear: error" : this.statusBarText(config));
    this.ui.setWidget(WATCH_STATUS_KEY, ["Linear watch", ...this.logs.slice(-12)]);
  }

  logMessage(config: Config, message: string, level: "info" | "warning" | "error" = "info") {
    this.log(config, message, level);
  }

  getLogs(config = readConfig()): string {
    return this.logs.length ? this.logs.join("\n") : `No logs yet. Log file: ${logPath(config.repoRoot)}`;
  }

  // ── Status ───────────────────────────────────────────────────────────────────

  statusBarText(config = readConfig()): string {
    if (!this.isWatching(config)) return `Linear: stopped (${path.basename(config.repoRoot)})`;
    const workers = this.listWorkers("running", config).length;
    const pid = readDaemonPid(config.repoRoot);
    const mode = pid && isPidRunning(pid) ? `daemon ${pid}` : "foreground";
    const agent = resolveAgentPreset(config.agent);
    const agentSuffix = agent.id === DEFAULT_AGENT ? "" : ` · ${agent.label}`;
    return `Linear: 🟢 ${path.basename(config.repoRoot)} ${mode}${workers ? ` · ${workers} worker${workers === 1 ? "" : "s"}` : ""}${agentSuffix}`;
  }

  statusSummary(config = readConfig(), includeRecentLogs = false): string {
    const workers = this.listWorkers("running", config);
    const lines = [
      `Linear watcher: ${this.isWatching(config) ? "running" : "stopped"}`,
      `Daemon pid: ${this.daemonPidSummary(config)}`,
      `Label: ${config.triggerLabel}`,
      `Agent: ${resolveAgentPreset(config.agent).label} (${resolveAgentPreset(config.agent).id})`,
      `Repo: ${config.repoRoot}`,
      `Interval: ${config.pollIntervalMs}ms`,
      `Required assignee: ${config.requireAssigneeMe ? config.watchAssignee : "disabled"}`,
      `Running workers: ${workers.length}`,
      `Logs: ${logPath(config.repoRoot)}`,
    ];
    if (includeRecentLogs) lines.push("", "Recent logs:", this.getLogs(config));
    return lines.join("\n");
  }

  private daemonPidSummary(config = readConfig()): string {
    const pid = readDaemonPid(config.repoRoot);
    if (!pid) return "none";
    return isPidRunning(pid) ? String(pid) : `${pid} (stale)`;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async shutdown() {
    this.stopWatch();
    await this.linear.shutdown().catch(() => {});
  }

  stopWatch() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.watchConfig = undefined;
  }

  isWatching(config = readConfig()) {
    return Boolean(this.timer && this.watchConfig?.repoRoot === config.repoRoot)
      || isDaemonRunning(config.repoRoot);
  }

  // ── Daemon ───────────────────────────────────────────────────────────────────

  startDaemon(daemonEntry: string, config: Config): string {
    const pid = readDaemonPid(config.repoRoot);
    if (pid && isPidRunning(pid)) return this.statusSummary(config);

    fs.mkdirSync(repoScopeDir(config.repoRoot), { recursive: true });
    const out = fs.openSync(logPath(config.repoRoot), "a");

    // Determine how to run the daemon entry: tsx for .ts files, node for .js
    const isTsEntry = daemonEntry.endsWith(".ts");
    const tsxBin = process.env.LINEAR_PI_TSX_BIN
      || path.join(path.dirname(process.execPath), "tsx")
      || "tsx";

    const [command, args] = isTsEntry
      ? [tsxBin, [daemonEntry, "--daemon"]]
      : [process.execPath, [daemonEntry, "--daemon"]];

    if (isTsEntry && !fs.existsSync(tsxBin)) {
      throw new Error(`Cannot start daemon: tsx not found at ${tsxBin}. Set LINEAR_PI_TSX_BIN to override.`);
    }

    const child = spawn(command, args, {
      cwd: config.repoRoot,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, LINEAR_PI_DAEMON: "1", LINEAR_PI_REPO_ROOT: config.repoRoot },
    });
    child.unref();
    fs.writeFileSync(pidPath(config.repoRoot), String(child.pid));
    this.log(config, `Started daemon watcher pid ${child.pid}.`);
    return this.statusSummary(config);
  }

  stopDaemon(config = readConfig()): string | undefined {
    const pid = readDaemonPid(config.repoRoot);
    if (!pid) return undefined;
    if (isPidRunning(pid)) process.kill(pid, "SIGTERM");
    fs.rmSync(pidPath(config.repoRoot), { force: true });
    return `Stopped daemon watcher pid ${pid}.`;
  }

  // ── Watch loop ───────────────────────────────────────────────────────────────

  startWatch(config: Config, label?: string) {
    if (label) {
      setTriggerLabel(label, config.repoRoot);
      config = readConfig(config.repoRoot);
    }
    if (this.timer) {
      this.log(config, `Watcher already running. Label: ${config.triggerLabel}.`, "warning");
      return;
    }
    this.watchConfig = config;
    this.log(config, `Watcher starting. Interval: ${config.pollIntervalMs}ms. Label: ${config.triggerLabel}. Repo: ${config.repoRoot}.`);
    const handleTickError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log(config, `Watch tick failed: ${message}`, "error");
      this.ui.notify(`Linear watch failed: ${message}`, "error");
    };
    this.timer = setInterval(() => {
      void this.watchOnce(this.watchConfig ?? config).catch(handleTickError);
    }, config.pollIntervalMs);
    void this.watchOnce(config).catch(handleTickError);
  }

  async watchOnce(config: Config, label?: string): Promise<string> {
    if (label) {
      setTriggerLabel(label, config.repoRoot);
      config = readConfig(config.repoRoot);
      this.log(config, `Updated watched label to ${config.triggerLabel}.`);
    }
    const tickConfig = this.watchConfig ?? config;
    if (this.runningOnce) {
      const message = "Watcher already running; skipped overlapping tick.";
      this.log(tickConfig, message, "warning");
      return message;
    }
    this.runningOnce = true;
    try {
      this.log(tickConfig, `Polling for label ${tickConfig.triggerLabel}${tickConfig.requireAssigneeMe ? ` assigned to ${tickConfig.watchAssignee}` : ""} (limit ${tickConfig.issueLimit})...`);

      const cleanupResult = await this.cleanup("done", tickConfig);
      if (cleanupResult.startsWith("Cleaned ")) {
        this.log(tickConfig, `Auto-cleaned done worker(s): ${cleanupResult}`);
      } else {
        this.log(tickConfig, `Auto-cleanup check: ${cleanupResult}`);
      }

      await this.restoreLostSessions(tickConfig);
      await this.refreshWindowNames(tickConfig);

      const listArgs: Record<string, unknown> = {
        label: tickConfig.triggerLabel,
        limit: tickConfig.issueLimit,
        orderBy: "updatedAt",
        includeArchived: false,
      };
      if (tickConfig.requireAssigneeMe) listArgs.assignee = tickConfig.watchAssignee;

      const issues = await this.linear.listIssues(listArgs as any);
      this.log(tickConfig, `Linear returned ${issues.length} issue(s).`);

      const state = readState(tickConfig.repoRoot);
      const started: string[] = [];
      const skipped: string[] = [];

      for (const issue of issues) {
        const id = issue.id;
        const labels = issueLabels(issue);
        if (!id) { skipped.push("unknown issue: missing id"); continue; }
        if (state.workers[id]?.status === "running") { skipped.push(`${id}: already has running worker`); continue; }
        if (isIssueDoneOrCanceled(issue)) { skipped.push(`${id}: status is ${issue.status || issue.statusType || "done/canceled"}`); continue; }
        const blockingLabels = [tickConfig.runningLabel, tickConfig.doneLabel, tickConfig.blockedLabel].filter((l) => labels.includes(l));
        if (blockingLabels.length) { skipped.push(`${id}: has ${blockingLabels.join(", ")}`); continue; }

        const resourceCheck = checkResourceCapacity(tickConfig);
        if (!resourceCheck.ok) {
          const message = `Skipping worker start for ${id}: insufficient server capacity (${resourceCheck.reason}). ${resourceCheck.details}.`;
          this.log(tickConfig, message, "warning");
          skipped.push(`${id}: insufficient capacity (${resourceCheck.reason})`);
          break; // Stop starting more workers this tick; retry once capacity frees up.
        }

        this.log(tickConfig, `Starting worker for ${id} (${issue.title})...`);
        const worker = await this.startIssue(id, tickConfig);
        started.push(`${id} -> ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}`);
        this.log(tickConfig, `Started ${id}: ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}.`);
      }

      if (skipped.length) this.log(tickConfig, `Skipped: ${skipped.join("; ")}.`);
      const message = started.length
        ? `Started ${started.length} worker(s) for label \`${tickConfig.triggerLabel}\`:\n${started.join("\n")}`
        : `No issues with label \`${tickConfig.triggerLabel}\` to start.`;
      this.log(tickConfig, started.length ? `Tick done. Started ${started.length}.` : "Tick done. Nothing to start.");
      return message;
    } catch (error) {
      this.log(tickConfig, `Tick failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      throw error;
    } finally {
      this.runningOnce = false;
    }
  }

  // ── Workers ──────────────────────────────────────────────────────────────────

  listWorkers(status?: WorkerState["status"], config = readConfig()): WorkerState[] {
    const workers = Object.values(readState(config.repoRoot).workers);
    return status ? workers.filter((w) => w.status === status) : workers;
  }

  async startIssue(issueId: string, config: Config): Promise<WorkerState> {
    return withStateLock(config.repoRoot, () => this.startIssueLocked(issueId, config));
  }

  private async startIssueLocked(issueId: string, config: Config): Promise<WorkerState> {
    const issue = await this.linear.getIssue(issueId.trim());
    const identifier = issue.id || issueId.trim();
    await this.assertIssueCanStart(issue, config);
    const state = readState(config.repoRoot);
    if (state.workers[identifier]?.status === "running") return state.workers[identifier];

    const resourceCheck = checkResourceCapacity(config);
    if (!resourceCheck.ok) {
      const message = `Refusing to start ${identifier}: insufficient server capacity (${resourceCheck.reason}). ${resourceCheck.details}.`;
      this.log(config, message, "warning");
      throw new Error(message);
    }

    const slug = slugify(`${identifier}-${issue.title}`);
    const branch = `${config.branchPrefix}/${slug}`;
    const windowName = buildWindowName(issue);

    try {
      const worktree = await this.ensureWorktree(config, branch);
      const attachments = await this.collectIssueAttachments(issue, worktree, config);
      const promptPath = path.join(worktree, ".pi-linear-prompt.md");
      fs.writeFileSync(promptPath, buildWorkerPrompt(issue, branch, worktree, attachments));

      const { id: tmuxWindowId, index, panePid } = await startTmuxWindow(config, windowName, worktree, identifier, promptPath);
      const worker: WorkerState = {
        identifier,
        title: issue.title,
        branch,
        worktree,
        repoRoot: config.repoRoot,
        tmuxSession: config.tmuxSession,
        tmuxWindow: windowName,
        tmuxWindowId,
        tmuxWindowIndex: index,
        panePid,
        status: "running",
        linearStatus: issue.status,
        startedAt: new Date().toISOString(),
      };
      state.workers[identifier] = worker;
      writeState(state, config.repoRoot);

      await this.markLinearRunning(config, issue, worker).catch((error) => {
        this.ui.notify(`Worker started, but Linear update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });
      return worker;
    } catch (error) {
      const worker: WorkerState = {
        identifier,
        title: issue.title,
        branch,
        worktree: "",
        repoRoot: config.repoRoot,
        tmuxSession: config.tmuxSession,
        tmuxWindow: windowName,
        status: "failed",
        startedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      state.workers[identifier] = worker;
      writeState(state, config.repoRoot);
      await this.linear.saveComment(identifier, `Pi worker failed to start.\n\n\`\`\`\n${worker.error}\n\`\`\``).catch(() => {});
      throw error;
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  async cleanupInteractive(config: Config): Promise<string> {
    const workers = this.listWorkers("running", config);
    if (!workers.length) return "No running Linear Pi workers recorded.";

    const choices = workers.map((w) => this.formatWorkerChoice(w));
    const selected = await this.ui.select("Select Linear Pi worker to clean", choices);
    if (!selected) return "Cleanup cancelled.";

    const worker = workers[choices.indexOf(selected)];
    if (!worker) return "Cleanup cancelled.";

    const confirmed = await this.ui.confirm(
      `Clean ${worker.identifier}?`,
      `This will kill tmux window ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow} and remove worktree ${worker.worktree}.`,
    );
    if (!confirmed) return "Cleanup cancelled.";
    return this.cleanup(worker.identifier, config);
  }

  async cleanup(target: string, config: Config): Promise<string> {
    const normalized = target.trim();
    if (normalized === "orphans") return this.cleanupOrphans(config);

    const state = readState(config.repoRoot);
    const workers = Object.values(state.workers);
    const cleaned: string[] = [];
    const skipped: string[] = [];

    for (const worker of workers) {
      const shouldClean = await this.shouldCleanupWorker(worker, normalized, config);
      if (!shouldClean) { skipped.push(worker.identifier); continue; }

      // Kill the process tree first, then the tmux window.
      await killWorkerProcesses(worker).catch((error) => {
        this.ui.notify(`Failed to kill processes for ${worker.identifier}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });

      await killTmuxWindow(worker).catch((error) => {
        this.ui.notify(`Failed to kill tmux window for ${worker.identifier}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });

      // Verify all worker processes are gone before removing the worktree.
      if (worker.worktree) {
        const allDead = await verifyNoWorktreeProcesses(worker.worktree);
        if (!allDead) {
          const msg = `Processes for ${worker.identifier} are still alive after kill; keeping state entry.`;
          this.ui.notify(msg, "warning");
          skipped.push(`${worker.identifier} (processes still running)`);
          continue;
        }
      }

      try {
        await this.removeWorktree(worker, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ui.notify(`Failed to remove worktree for ${worker.identifier}: ${message}`, "warning");
        skipped.push(`${worker.identifier} (cleanup failed: ${message})`);
        continue;
      }

      try {
        await this.markLinearCleaned(worker, normalized, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ui.notify(`Cleaned local worker for ${worker.identifier}, but failed to update Linear labels: ${message}`, "warning");
        skipped.push(`${worker.identifier} (Linear labels not updated: ${message})`);
        continue;
      }

      delete state.workers[worker.identifier];
      cleaned.push(worker.identifier);
    }

    writeState(state, config.repoRoot);
    const removedRepoScopeDir = cleaned.length > 0 && !this.isWatching(config) && removeRepoScopeDirIfUnused(config.repoRoot);
    if (!cleaned.length) {
      return normalized === "done"
        ? `No done workers found. Skipped: ${skipped.join(", ") || "none"}`
        : skipped.length
          ? `No workers cleaned. Skipped: ${skipped.join(", ")}`
          : `No matching workers found for "${normalized}".`;
    }
    return `Cleaned ${cleaned.length} worker(s): ${cleaned.join(", ")}${skipped.length ? `\nSkipped: ${skipped.join(", ")}` : ""}${removedRepoScopeDir ? `\nRemoved repo temp folder: ${repoScopeDir(config.repoRoot)}` : ""}`;
  }

  private async cleanupOrphans(config: Config): Promise<string> {
    const self = process.pid;
    const killed: string[] = [];

    const killPids = async (pids: number[], label: string): Promise<void> => {
      if (!pids.length) return;
      for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
      await new Promise(r => setTimeout(r, 2000));
      for (const pid of pids) {
        try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); killed.push(`${label}:${pid}`); } catch {}
      }
    };

    const pgrepPids = async (pattern: string): Promise<number[]> => {
      const { stdout } = await execFileAsync("pgrep", ["-f", pattern], { maxBuffer: 1024 * 1024 })
        .catch(() => ({ stdout: "" }));
      return stdout.trim().split("\n").filter(Boolean).map(Number).filter(p => !isNaN(p) && p !== self);
    };

    // Processes whose command references the wt trash directory.
    const trashDir = path.join(config.repoRoot, ".git", "wt", "trash");
    if (fs.existsSync(trashDir)) {
      await killPids(await pgrepPids(trashDir), "trash");
    }

    // Processes referencing worktree paths that are recorded in state but no longer exist on disk.
    const state = readState(config.repoRoot);
    for (const worker of Object.values(state.workers)) {
      if (worker.worktree && !fs.existsSync(worker.worktree)) {
        await killPids(await pgrepPids(worker.worktree), worker.identifier);
      }
    }

    return killed.length
      ? `Killed ${killed.length} orphaned process(es): ${killed.join(", ")}`
      : "No orphaned processes found.";
  }

  async cleanupIfIssueDone(
    issueRef: string | undefined,
    config: Config,
    savedIssue?: Partial<LinearIssue>,
  ): Promise<string | undefined> {
    const state = readState(config.repoRoot);
    const refs = Array.from(new Set([issueRef, savedIssue?.identifier, savedIssue?.id].filter((r): r is string => typeof r === "string" && r.trim().length > 0)));
    if (!refs.length) return undefined;

    const worker = Object.values(state.workers).find(
      (w) => refs.some((ref) => w.identifier.toLowerCase() === ref.toLowerCase()),
    );
    if (!worker) return undefined;

    const issue = await this.linear.getIssue(worker.identifier).catch(() => undefined);
    if (!issue) return undefined;
    if (!issueLabels(issue).includes(config.doneLabel) && !isIssueDoneOrCanceled(issue)) return undefined;
    return this.cleanup(worker.identifier, config);
  }

  // ── Agent selection ──────────────────────────────────────────────────────────

  async selectAgent(config: Config): Promise<void> {
    const presets = Object.values(AGENT_PRESETS);
    const choices = presets.map((p) => `${p.label} (${p.id})${p.id === config.agent ? " — current" : ""}`);
    const selected = await this.ui.select("Select agent to run for Linear workers", choices);
    if (!selected) {
      this.ui.notify(`Agent unchanged: ${resolveAgentPreset(config.agent).label}.`, "info");
      return;
    }
    const target = presets[choices.indexOf(selected)].id;
    const updated = setAgentConfig(target, config.repoRoot);
    this.ui.notify(`Agent set to ${resolveAgentPreset(updated.agent).label}. Restart daemon to pick it up.`, "info");
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private formatWorkerChoice(worker: WorkerState): string {
    return `${worker.identifier} — ${worker.title}\n  tmux: ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}\n  branch: ${worker.branch}\n  worktree: ${worker.worktree}`;
  }

  /**
   * Recreate the tmux window (and session, if that was lost too) for any worker
   * recorded as "running" whose tmux window no longer exists — e.g. after a tmux
   * server crash/restart wiped all sessions. Never throws — a restore problem
   * must not break the poll tick.
   */
  private async restoreLostSessions(config: Config): Promise<void> {
    const workers = Object.values(readState(config.repoRoot).workers).filter((w) => w.status === "running");
    for (const worker of workers) {
      try {
        const target = await resolveTmuxWindowTarget(worker);
        if (target) continue;

        if (!worker.worktree || !fs.existsSync(worker.worktree)) {
          this.log(config, `Cannot restore session for ${worker.identifier}: worktree missing (${worker.worktree || "none"}).`, "warning");
          continue;
        }
        const promptPath = path.join(worker.worktree, ".pi-linear-prompt.md");
        if (!fs.existsSync(promptPath)) {
          this.log(config, `Cannot restore session for ${worker.identifier}: prompt file missing (${promptPath}).`, "warning");
          continue;
        }

        this.log(config, `Tmux session/window for ${worker.identifier} is gone; recreating it.`, "warning");
        const restoreConfig: Config = { ...config, tmuxSession: worker.tmuxSession || config.tmuxSession };
        const { id: tmuxWindowId, index, panePid } = await startTmuxWindow(
          restoreConfig, worker.tmuxWindow, worker.worktree, worker.identifier, promptPath,
        );
        await withStateLock(config.repoRoot, async () => {
          const state = readState(config.repoRoot);
          const current = state.workers[worker.identifier];
          if (!current) return;
          current.tmuxSession = restoreConfig.tmuxSession;
          current.tmuxWindowId = tmuxWindowId;
          current.tmuxWindowIndex = index;
          current.panePid = panePid;
          writeState(state, config.repoRoot);
        });
        this.log(config, `Restored ${worker.identifier}: ${restoreConfig.tmuxSession}:${index}:${worker.tmuxWindow}.`);
      } catch (error) {
        this.log(config, `Failed to restore session for ${worker.identifier}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }
  }

  /**
   * Re-fetch each running worker's Linear status and rename its tmux window to
   * reflect the current workflow state (e.g. `[REV] ENG-123 fix-login`). Only
   * renames when the computed name changed. Never throws — a rename problem must
   * not break the poll tick.
   */
  private async refreshWindowNames(config: Config): Promise<void> {
    const workers = Object.values(readState(config.repoRoot).workers).filter((w) => w.status === "running");
    for (const worker of workers) {
      try {
        const issue = await this.linear.getIssue(worker.identifier).catch(() => undefined);
        if (!issue) continue;
        const newName = buildWindowName(issue);
        if (newName === worker.tmuxWindow) continue;
        const renamed = await renameTmuxWindow(worker, newName);
        if (!renamed) continue;
        await withStateLock(config.repoRoot, async () => {
          const state = readState(config.repoRoot);
          const current = state.workers[worker.identifier];
          if (!current) return;
          current.tmuxWindow = newName;
          current.linearStatus = issue.status;
          writeState(state, config.repoRoot);
        });
        this.log(config, `Renamed window for ${worker.identifier} -> ${newName}.`);
      } catch (error) {
        this.log(config, `Failed to refresh window name for ${worker.identifier}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }
  }

  private async shouldCleanupWorker(worker: WorkerState, target: string, config: Config): Promise<boolean> {
    if (!target || target === "done") {
      const issue = await this.linear.getIssue(worker.identifier).catch(() => undefined);
      if (!issue) return false;
      return issueLabels(issue).includes(config.doneLabel) || isIssueDoneOrCanceled(issue);
    }
    if (target === "all") return true;
    return worker.identifier.toLowerCase() === target.toLowerCase()
      || worker.tmuxWindow === target
      || worker.branch === target;
  }

  private async markLinearCleaned(worker: WorkerState, target: string, config: Config): Promise<void> {
    const issue = await this.linear.getIssue(worker.identifier);
    const labels = issueLabels(issue).filter((l) => l !== config.triggerLabel && l !== config.runningLabel);
    if ((target === "done" || isIssueDoneOrCanceled(issue)) && !labels.includes(config.doneLabel)) {
      labels.push(config.doneLabel);
    }
    await this.linear.saveIssue({ id: worker.identifier, labels: Array.from(new Set(labels)) });
  }

  private async markLinearRunning(config: Config, issue: LinearIssue, worker: WorkerState) {
    const labels = Array.from(new Set([...issueLabels(issue), config.triggerLabel, config.runningLabel]));
    await (async () => {
      if (config.setInProgress) {
        await this.linear.saveIssue({ id: worker.identifier, state: config.inProgressState, labels }).catch(async () => {
          await this.linear.saveIssue({ id: worker.identifier, labels });
        });
      } else {
        await this.linear.saveIssue({ id: worker.identifier, labels });
      }
    })().catch(() => {});
    await this.linear.saveComment(
      worker.identifier,
      `Started Pi worker:\n\n- repo: \`${config.repoRoot}\`\n- tmux: \`${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}\`\n- branch: \`${worker.branch}\`\n- worktree: \`${worker.worktree}\``,
    );
  }

  private async assertIssueCanStart(issue: LinearIssue, config: Config): Promise<void> {
    const labels = issueLabels(issue);
    if (!labels.includes(config.triggerLabel)) {
      throw new Error(`Refusing to start ${issue.id}: missing required label ${config.triggerLabel}.`);
    }
    if (!config.requireAssigneeMe) return;

    const assignedIssues = await this.linear.listIssues({
      label: config.triggerLabel,
      assignee: config.watchAssignee,
      limit: 250,
      orderBy: "updatedAt",
      includeArchived: false,
    });
    if (!assignedIssues.some((i) => i.id === issue.id)) {
      throw new Error(`Refusing to start ${issue.id}: issue must be assigned to ${config.watchAssignee}.`);
    }
  }

  private async collectIssueAttachments(
    issue: LinearIssue,
    worktree: string,
    config: Config,
  ): Promise<WorkerPromptAttachment[]> {
    const attachments = issue.attachments || [];
    const inlineImageUrls = extractMarkdownImageUrls(issue.description);
    if (!attachments.length && !inlineImageUrls.length) return [];

    const dir = path.join(worktree, ".pi-linear-attachments");
    fs.mkdirSync(dir, { recursive: true });

    const collected: WorkerPromptAttachment[] = [];

    if (inlineImageUrls.length) {
      try {
        const images = await this.linear.extractImages(issue.description || "");
        images.forEach((img, index) => {
          const ext = extensionForMimeType(img.mimeType);
          const filePath = path.join(dir, `inline-image-${index + 1}${ext}`);
          fs.writeFileSync(filePath, Buffer.from(img.data, "base64"));
          collected.push({
            id: `inline-image-${index + 1}`,
            title: `Inline image ${index + 1}`,
            url: inlineImageUrls[index],
            localPath: filePath,
            contentPreview: `Saved embedded Linear description image to ${filePath}`,
          });
        });
      } catch (error) {
        collected.push({
          id: "inline-images",
          title: "Inline images from description",
          contentPreview: inlineImageUrls.map((url) => `- ${url}`).join("\n"),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const attachment of attachments) {
      const item: WorkerPromptAttachment = { ...attachment };
      try {
        const content = await this.linear.getAttachment(attachment.id);
        const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
        const fileName = `${slugify(attachment.title || attachment.id, 80)}${extensionForAttachmentContent(text)}`;
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, text);
        item.localPath = filePath;
        item.contentPreview = text.slice(0, 12_000);
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
      }
      collected.push(item);
    }
    return collected;
  }

  private async ensureWorktree(config: Config, branch: string): Promise<string> {
    const branchExists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: config.repoRoot })
      .then(() => true).catch(() => false);

    const args = ["switch"];
    if (!branchExists) args.push("--create");
    args.push(branch);
    if (!branchExists) args.push("--base", await this.resolveBaseBranch(config));
    args.push("--format", "json", "-y");

    const { stdout } = await execFileAsync("wt", args, { cwd: config.repoRoot, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim());
    const worktree = parsed.worktree_path || parsed.worktreePath || parsed.path || parsed.worktree?.path;
    if (worktree) return worktree;

    const { stdout: listOut } = await execFileAsync("wt", ["list", "--format", "json"], { cwd: config.repoRoot, maxBuffer: 1024 * 1024 });
    const entries = JSON.parse(listOut);
    const match = Array.isArray(entries) ? entries.find((e: any) => e.branch === branch) : undefined;
    if (match?.path) return match.path;
    throw new Error(`Created branch ${branch} but could not resolve worktree path.`);
  }

  private async resolveBaseBranch(config: Config): Promise<string> {
    const candidates = [
      config.baseBranch,
      await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: config.repoRoot, encoding: "utf8" })
        .then(({ stdout }) => stdout.trim()).catch(() => ""),
      "origin/main",
      "origin/master",
      "main",
      "master",
    ].filter(Boolean);

    for (const candidate of Array.from(new Set(candidates))) {
      const exists = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd: config.repoRoot })
        .then(() => true).catch(() => false);
      if (exists) return candidate;
    }
    throw new Error(`Could not resolve base branch. Tried: ${candidates.join(", ")}`);
  }

  private async removeWorktree(worker: WorkerState, config: Config): Promise<void> {
    const cwd = this.cleanupRepoRoot(worker, config);
    const target = worker.branch || (worker.worktree && fs.existsSync(worker.worktree) ? worker.worktree : "");
    if (!target) return;

    const wtRemoved = await execFileAsync("wt", ["-C", cwd, "remove", target, "--force", "-D", "--foreground", "-y", "--no-hooks"], { maxBuffer: 1024 * 1024 })
      .then(() => true).catch(() => false);
    if (wtRemoved) return;

    if (worker.worktree && fs.existsSync(worker.worktree)) {
      await execFileAsync("git", ["worktree", "remove", "--force", worker.worktree], { cwd, maxBuffer: 1024 * 1024 });
    }
    if (worker.branch && await this.localBranchExists(cwd, worker.branch)) {
      await execFileAsync("git", ["branch", "-D", worker.branch], { cwd, maxBuffer: 1024 * 1024 });
    }
  }

  private cleanupRepoRoot(worker: WorkerState, config: Config): string {
    if (worker.repoRoot && fs.existsSync(worker.repoRoot)) return worker.repoRoot;
    if (worker.worktree && fs.existsSync(worker.worktree)) {
      try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: worker.worktree,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {}
    }
    return config.repoRoot;
  }

  private async localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
    return execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot })
      .then(() => true).catch(() => false);
  }
}
