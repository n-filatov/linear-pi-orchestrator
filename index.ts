import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpServerManager } from "/Users/nikita.filatov/.pi/agent/npm/node_modules/pi-mcp-adapter/server-manager.ts";
import { loadMcpConfig } from "/Users/nikita.filatov/.pi/agent/npm/node_modules/pi-mcp-adapter/config.ts";
import type { ServerEntry } from "/Users/nikita.filatov/.pi/agent/npm/node_modules/pi-mcp-adapter/types.ts";

const execFileAsync = promisify(execFile);

type LinearIssue = {
  id: string;
  title: string;
  description?: string;
  url?: string;
  gitBranchName?: string;
  status?: string;
  statusType?: string;
  labels?: Array<string | { name?: string; id?: string }>;
  assignee?: string | { id?: string; name?: string; email?: string; displayName?: string } | null;
  assigneeId?: string | null;
  team?: string;
};

type WorkerState = {
  identifier: string;
  title: string;
  branch: string;
  worktree: string;
  repoRoot?: string;
  tmuxSession: string;
  tmuxWindow: string;
  tmuxWindowIndex?: string;
  status: "running" | "failed";
  startedAt: string;
  error?: string;
};

type StateFile = { workers: Record<string, WorkerState> };

type Config = {
  mcpServer: string;
  triggerLabel: string;
  runningLabel: string;
  doneLabel: string;
  blockedLabel: string;
  pollIntervalMs: number;
  tmuxSession: string;
  repoRoot: string;
  baseBranch: string;
  branchPrefix: string;
  piCommand: string;
  nodeBinDir: string;
  issueLimit: number;
  requireAssigneeMe: boolean;
  watchAssignee: string;
  setInProgress: boolean;
  inProgressState: string;
};

const CONFIG_DIR = path.join(os.homedir(), ".pi", "linear-pi");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const REPOS_DIR = path.join(CONFIG_DIR, "repos");
const WATCH_STATUS_KEY = "linear-watch";
const WATCH_BAR_INTERVAL_MS = 30_000;

function findCompatibleNodeBinDir(): string {
  if (process.env.LINEAR_PI_NODE_BIN_DIR) return process.env.LINEAR_PI_NODE_BIN_DIR;

  const candidates = [
    path.dirname(process.execPath),
    ...globNodeBinDirs(path.join(os.homedir(), ".local", "share", "nvm")),
    ...globNodeBinDirs(path.join(os.homedir(), ".nvm", "versions", "node")),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  for (const binDir of Array.from(new Set(candidates))) {
    const node = path.join(binDir, "node");
    if (!fs.existsSync(node)) continue;
    try {
      execFileSync(node, ["-e", "new RegExp('', 'v')"], { stdio: "ignore" });
      return binDir;
    } catch {
      // Try next candidate.
    }
  }

  return path.dirname(process.execPath);
}

function globNodeBinDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((entry) => entry.startsWith("v"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((entry) => path.join(root, entry, "bin"));
}

function defaultConfig(repoRoot = process.env.LINEAR_PI_REPO_ROOT || process.cwd()): Config {
  return {
    mcpServer: process.env.LINEAR_PI_MCP_SERVER || "linear",
    triggerLabel: process.env.LINEAR_PI_TRIGGER_LABEL || "pi:implement",
    runningLabel: process.env.LINEAR_PI_RUNNING_LABEL || "pi:running",
    doneLabel: process.env.LINEAR_PI_DONE_LABEL || "pi:done",
    blockedLabel: process.env.LINEAR_PI_BLOCKED_LABEL || "pi:blocked",
    pollIntervalMs: Number(process.env.LINEAR_PI_POLL_INTERVAL_MS || 30_000),
    tmuxSession: process.env.LINEAR_PI_TMUX_SESSION || "linear-pi",
    repoRoot,
    baseBranch: process.env.LINEAR_PI_BASE_BRANCH || "origin/main",
    branchPrefix: process.env.LINEAR_PI_BRANCH_PREFIX || "feat",
    piCommand: process.env.LINEAR_PI_PI_COMMAND || "pi",
    nodeBinDir: findCompatibleNodeBinDir(),
    issueLimit: Number(process.env.LINEAR_PI_ISSUE_LIMIT || 50),
    requireAssigneeMe: process.env.LINEAR_PI_REQUIRE_ASSIGNEE_ME !== "false",
    watchAssignee: process.env.LINEAR_PI_WATCH_ASSIGNEE || "me",
    setInProgress: process.env.LINEAR_PI_SET_IN_PROGRESS !== "false",
    inProgressState: process.env.LINEAR_PI_IN_PROGRESS_STATE || "In Progress",
  };
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function repoScopeDir(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 10);
  return path.join(REPOS_DIR, `${base}-${hash}`);
}

function configPath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "config.json"); }
function statePath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "state.json"); }
function logPath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "watch.log"); }
function pidPath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "watch.pid"); }
function barPrefPath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "watch-bar.json"); }

function readJsonFile<T extends object>(filePath: string): Partial<T> {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
  } catch {
    return {};
  }
}

function readConfig(repoRootHint?: string): Config {
  ensureConfigDir();
  const globalConfig = readJsonFile<Config>(CONFIG_PATH);
  const repoRoot = path.resolve(repoRootHint || process.env.LINEAR_PI_REPO_ROOT || (typeof globalConfig.repoRoot === "string" ? globalConfig.repoRoot : "") || process.cwd());
  const scopedPath = configPath(repoRoot);
  const scopedConfig = readJsonFile<Config>(scopedPath);
  const config = { ...defaultConfig(repoRoot), ...globalConfig, ...scopedConfig, repoRoot };
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(repoRoot), null, 2));
  if (!fs.existsSync(scopedPath)) writeConfig(config);
  return config;
}

function writeConfig(config: Config) {
  ensureConfigDir();
  const scopedDir = repoScopeDir(config.repoRoot);
  fs.mkdirSync(scopedDir, { recursive: true });
  fs.writeFileSync(configPath(config.repoRoot), JSON.stringify(config, null, 2));
}

function setTriggerLabel(label: string, repoRoot?: string): Config {
  const config = readConfig(repoRoot);
  config.triggerLabel = label;
  writeConfig(config);
  return config;
}

function readState(repoRoot = readConfig().repoRoot): StateFile {
  ensureConfigDir();
  const filePath = statePath(repoRoot);
  if (!fs.existsSync(filePath)) return { workers: {} };
  return { workers: {}, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
}

function writeState(state: StateFile, repoRoot = readConfig().repoRoot) {
  ensureConfigDir();
  fs.mkdirSync(repoScopeDir(repoRoot), { recursive: true });
  fs.writeFileSync(statePath(repoRoot), JSON.stringify(state, null, 2));
}

function readDaemonPid(repoRoot = readConfig().repoRoot): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidPath(repoRoot), "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isDaemonRunning(repoRoot = readConfig().repoRoot): boolean {
  const pid = readDaemonPid(repoRoot);
  return Boolean(pid && isPidRunning(pid));
}

function tsxBinPath(): string {
  return process.env.LINEAR_PI_TSX_BIN || path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", ".bin", "tsx");
}

function readWatchBarPreference(repoRoot = readConfig().repoRoot): boolean | undefined {
  try {
    const filePath = barPrefPath(repoRoot);
    if (!fs.existsSync(filePath)) return undefined;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { enabled?: unknown };
    return typeof data.enabled === "boolean" ? data.enabled : undefined;
  } catch {
    return undefined;
  }
}

function writeWatchBarPreference(enabled: boolean, repoRoot = readConfig().repoRoot): boolean {
  try {
    ensureConfigDir();
    fs.mkdirSync(repoScopeDir(repoRoot), { recursive: true });
    fs.writeFileSync(barPrefPath(repoRoot), `${JSON.stringify({ enabled }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function slugify(input: string, max = 64): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "") || "linear-task";
}

function issueLabels(issue: LinearIssue): string[] {
  return (issue.labels || [])
    .map((label) => (typeof label === "string" ? label : label.name || label.id || ""))
    .filter(Boolean);
}

function parseMcpJson<T>(result: any): T {
  const text = (result?.content || [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
  if (!text) return result as T;
  return JSON.parse(text) as T;
}

class LinearPiOrchestrator {
  private manager = new McpServerManager();
  private timer: NodeJS.Timeout | undefined;
  private runningOnce = false;
  private watchConfig: Config | undefined;
  private logs: string[] = [];

  private log(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") {
    const config = this.watchConfig ?? readConfig(ctx?.cwd);
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    this.logs.push(line);
    this.logs = this.logs.slice(-50);
    try {
      ensureConfigDir();
      fs.mkdirSync(repoScopeDir(config.repoRoot), { recursive: true });
      fs.appendFileSync(logPath(config.repoRoot), `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
    } catch {
      // Keep in-memory/status logging working even if file logging is unavailable.
    }
    ctx?.ui?.setStatus?.(WATCH_STATUS_KEY, level === "error" ? "Linear: error" : this.statusBarText(config));
    ctx?.ui?.setWidget?.(WATCH_STATUS_KEY, ["Linear watch", ...this.logs.slice(-12)]);
  }

  getLogs(config = readConfig()): string {
    return this.logs.length ? this.logs.join("\n") : `No Linear watch logs yet. Log file: ${logPath(config.repoRoot)}`;
  }

  statusBarText(config = readConfig()): string {
    if (!this.isWatching(config)) return `Linear: stopped (${path.basename(config.repoRoot)})`;
    const workers = this.listWorkers("running", config).length;
    const pid = readDaemonPid(config.repoRoot);
    const mode = pid && isPidRunning(pid) ? `daemon ${pid}` : "foreground";
    return `Linear: 🟢 ${path.basename(config.repoRoot)} ${mode}${workers ? ` · ${workers} worker${workers === 1 ? "" : "s"}` : ""}`;
  }

  statusSummary(config = readConfig(), includeRecentLogs = false): string {
    const workers = this.listWorkers("running", config);
    const lines = [
      `Linear watcher: ${this.isWatching(config) ? "running" : "stopped"}`,
      `Daemon pid: ${this.daemonPidSummary(config)}`,
      `Label: ${config.triggerLabel}`,
      `Repo: ${config.repoRoot}`,
      `Interval: ${config.pollIntervalMs}ms`,
      `Required assignee: ${config.requireAssigneeMe ? config.watchAssignee : "disabled"}`,
      `Running workers: ${workers.length}`,
      `Logs: ${logPath(config.repoRoot)}`,
      `Config: ${configPath(config.repoRoot)}`,
      `State: ${statePath(config.repoRoot)}`,
    ];
    if (includeRecentLogs) lines.push("", "Recent logs:", this.getLogs(config));
    return lines.join("\n");
  }

  private daemonPidSummary(config = readConfig()): string {
    const pid = readDaemonPid(config.repoRoot);
    if (!pid) return "none";
    return isPidRunning(pid) ? String(pid) : `${pid} (stale)`;
  }

  async shutdown() {
    this.stopWatch();
    await this.manager.closeAll().catch(() => {});
  }

  stopWatch(ctx?: ExtensionContext) {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.watchConfig = undefined;
    this.log(ctx, "Watcher stopped.");
  }

  isWatching(config = readConfig()) {
    return Boolean(this.timer && this.watchConfig?.repoRoot === config.repoRoot) || isDaemonRunning(config.repoRoot);
  }

  startDaemon(ctx: ExtensionContext, label?: string): string {
    const contextConfig = this.configForContext(ctx);
    if (label) setTriggerLabel(label, contextConfig.repoRoot);
    const config = label ? readConfig(contextConfig.repoRoot) : contextConfig;
    const pid = readDaemonPid(config.repoRoot);
    if (pid && isPidRunning(pid)) return this.statusSummary(config);

    ensureConfigDir();
    fs.mkdirSync(repoScopeDir(config.repoRoot), { recursive: true });
    const out = fs.openSync(logPath(config.repoRoot), "a");
    const command = tsxBinPath();
    if (!fs.existsSync(command)) throw new Error(`Cannot start watcher daemon: tsx not found at ${command}. Set LINEAR_PI_TSX_BIN to override.`);
    const child = spawn(command, [fileURLToPath(import.meta.url), "--linear-pi-daemon"], {
      cwd: config.repoRoot,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, LINEAR_PI_DAEMON: "1", LINEAR_PI_REPO_ROOT: config.repoRoot },
    });
    child.unref();
    fs.writeFileSync(pidPath(config.repoRoot), String(child.pid));
    this.log(ctx, `Started daemon watcher pid ${child.pid}.`);
    return this.statusSummary(config);
  }

  stopDaemon(config = readConfig()): string | undefined {
    const pid = readDaemonPid(config.repoRoot);
    if (!pid) return undefined;
    if (isPidRunning(pid)) process.kill(pid, "SIGTERM");
    fs.rmSync(pidPath(config.repoRoot), { force: true });
    return `Stopped daemon watcher pid ${pid}.`;
  }

  startWatch(ctx?: ExtensionContext, label?: string) {
    const contextConfig = this.configForContext(ctx);
    if (label) setTriggerLabel(label, contextConfig.repoRoot);
    const config = label ? readConfig(contextConfig.repoRoot) : contextConfig;
    if (this.timer) {
      this.log(ctx, `Watcher already running. Poll interval: ${config.pollIntervalMs}ms. Label: ${config.triggerLabel}.`, "warning");
      return;
    }
    this.watchConfig = config;
    this.log(ctx, `Watcher starting. Poll interval: ${config.pollIntervalMs}ms. Label: ${config.triggerLabel}. Repo: ${config.repoRoot}.`);
    this.timer = setInterval(() => {
      void this.watchOnce(ctx).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(ctx, `Watch tick failed: ${message}`, "error");
        ctx?.ui?.notify?.(`Linear watch failed: ${message}`, "error");
      });
    }, config.pollIntervalMs);
    void this.watchOnce(ctx);
  }

  async watchOnce(ctx?: ExtensionContext, label?: string): Promise<string> {
    if (label) {
      const config = setTriggerLabel(label, this.configForContext(ctx).repoRoot);
      this.log(ctx, `Updated watched label to ${config.triggerLabel}.`);
    }
    const tickConfig = label ? this.configForContext(ctx) : this.watchConfig ?? this.configForContext(ctx);
    if (this.runningOnce) {
      const message = "Watcher already running; skipped overlapping tick.";
      this.log(ctx, message, "warning");
      return message;
    }
    this.runningOnce = true;
    try {
      const config = tickConfig;
      this.log(ctx, `Polling Linear for label ${config.triggerLabel}${config.requireAssigneeMe ? ` assigned to ${config.watchAssignee}` : ""} in ${config.repoRoot} (limit ${config.issueLimit})...`);
      const listArgs: Record<string, unknown> = {
        label: config.triggerLabel,
        limit: config.issueLimit,
        orderBy: "updatedAt",
        includeArchived: false,
      };
      if (config.requireAssigneeMe) listArgs.assignee = config.watchAssignee;
      const response = await this.callLinear<LinearIssue[] | { issues?: LinearIssue[] }>("list_issues", listArgs, config);
      const issues = Array.isArray(response) ? response : response.issues || [];
      this.log(ctx, `Linear returned ${issues.length} issue(s).`);

      const state = readState(config.repoRoot);
      const started: string[] = [];
      const skipped: string[] = [];
      for (const issue of issues) {
        const id = issue.id;
        const labels = issueLabels(issue);
        if (!id) {
          skipped.push("unknown issue: missing id");
          continue;
        }
        if (state.workers[id]?.status === "running") {
          skipped.push(`${id}: already has running worker`);
          continue;
        }
        const blockingLabels = [config.runningLabel, config.doneLabel, config.blockedLabel].filter((blockedLabel) => labels.includes(blockedLabel));
        if (blockingLabels.length) {
          skipped.push(`${id}: has ${blockingLabels.join(", ")}`);
          continue;
        }
        this.log(ctx, `Starting worker for ${id} (${issue.title})...`);
        const worker = await this.startIssue(id, ctx, config);
        started.push(`${id} -> ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}`);
        this.log(ctx, `Started ${id}: ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}.`);
      }
      if (skipped.length) this.log(ctx, `Skipped: ${skipped.join("; ")}.`);
      const message = started.length ? `Started ${started.length} worker(s) for label \`${config.triggerLabel}\`:\n${started.join("\n")}` : `No Linear issues with label \`${config.triggerLabel}\` to start. Add label \`${config.triggerLabel}\` to a Linear issue to trigger this watcher.`;
      this.log(ctx, started.length ? `Tick done. Started ${started.length}.` : "Tick done. Nothing to start.");
      return message;
    } catch (error) {
      this.log(ctx, `Tick failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      throw error;
    } finally {
      this.runningOnce = false;
    }
  }

  listWorkers(status?: WorkerState["status"], config = readConfig()): WorkerState[] {
    const workers = Object.values(readState(config.repoRoot).workers);
    return status ? workers.filter((worker) => worker.status === status) : workers;
  }

  async cleanupInteractive(ctx: ExtensionContext): Promise<string> {
    const config = this.configForContext(ctx);
    const workers = this.listWorkers("running", config);
    if (!workers.length) return "No running Linear Pi workers recorded.";

    const choices = workers.map((worker) => this.formatWorkerChoice(worker));
    const selected = await ctx.ui.select("Select Linear Pi worker to clean", choices);
    if (!selected) return "Cleanup cancelled.";

    const worker = workers[choices.indexOf(selected)];
    if (!worker) return "Cleanup cancelled.";

    const confirmed = await ctx.ui.confirm(
      `Clean ${worker.identifier}?`,
      `This will kill tmux window ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow} and remove worktree ${worker.worktree}.`,
    );
    if (!confirmed) return "Cleanup cancelled.";

    return this.cleanup(worker.identifier, ctx);
  }

  async cleanup(target: string, ctx?: ExtensionContext): Promise<string> {
    const config = this.configForContext(ctx);
    const state = readState(config.repoRoot);
    const workers = Object.values(state.workers);
    const normalized = target.trim();
    const cleaned: string[] = [];
    const skipped: string[] = [];

    for (const worker of workers) {
      const shouldClean = await this.shouldCleanupWorker(worker, normalized, config);
      if (!shouldClean) {
        skipped.push(worker.identifier);
        continue;
      }

      await this.killTmuxWindow(worker).catch((error) => {
        ctx?.ui?.notify?.(`Failed to kill tmux window for ${worker.identifier}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      });

      try {
        await this.removeWorktree(worker, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx?.ui?.notify?.(`Failed to remove worktree/branch for ${worker.identifier}: ${message}`, "warning");
        skipped.push(`${worker.identifier} (cleanup failed: ${message})`);
        continue;
      }

      delete state.workers[worker.identifier];
      cleaned.push(worker.identifier);
    }

    writeState(state, config.repoRoot);
    if (!cleaned.length) {
      return normalized === "done"
        ? `No done workers found. Skipped: ${skipped.join(", ") || "none"}`
        : `No matching workers found for "${normalized}".`;
    }
    return `Cleaned ${cleaned.length} worker(s): ${cleaned.join(", ")}`;
  }

  private formatWorkerChoice(worker: WorkerState): string {
    return `${worker.identifier} — ${worker.title}\n  tmux: ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}\n  branch: ${worker.branch}\n  worktree: ${worker.worktree}`;
  }

  private async shouldCleanupWorker(worker: WorkerState, target: string, config: Config): Promise<boolean> {
    if (!target || target === "done") {
      const issue = await this.callLinear<LinearIssue>("get_issue", { id: worker.identifier }, config).catch(() => undefined);
      if (!issue) return false;
      const labels = issueLabels(issue);
      return labels.includes(config.doneLabel) || issue.statusType === "completed" || issue.statusType === "canceled" || issue.status === "Done" || issue.status === "Canceled";
    }
    if (target === "all") return true;
    return worker.identifier.toLowerCase() === target.toLowerCase() || worker.tmuxWindow === target || worker.branch === target;
  }

  private async killTmuxWindow(worker: WorkerState): Promise<void> {
    const targets = [
      worker.tmuxWindowIndex ? `${worker.tmuxSession}:${worker.tmuxWindowIndex}` : undefined,
      `${worker.tmuxSession}:${worker.tmuxWindow}`,
    ].filter(Boolean) as string[];

    for (const target of targets) {
      const ok = await execFileAsync("tmux", ["kill-window", "-t", target]).then(() => true).catch(() => false);
      if (ok) return;
    }
  }

  private async removeWorktree(worker: WorkerState, config: Config): Promise<void> {
    const cwd = this.cleanupRepoRoot(worker, config);
    const target = worker.branch || (worker.worktree && fs.existsSync(worker.worktree) ? worker.worktree : "");
    if (!target) return;

    const wtArgs = ["-C", cwd, "remove", target, "--force", "-D", "--foreground", "-y", "--no-hooks"];
    const wtRemoved = await execFileAsync("wt", wtArgs, { maxBuffer: 1024 * 1024 })
      .then(() => true)
      .catch(() => false);
    if (wtRemoved) return;

    // Fallback for stale records or older wt behavior: remove the git worktree by path
    // and force-delete the branch explicitly. Keep state if either critical step fails.
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
        return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: worker.worktree, encoding: "utf8" }).trim();
      } catch {
        // Fall through to configured repo root.
      }
    }
    return config.repoRoot;
  }

  private async localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
    return execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot })
      .then(() => true)
      .catch(() => false);
  }

  async startIssue(issueId: string, ctx?: ExtensionContext, providedConfig?: Config): Promise<WorkerState> {
    const config = providedConfig ?? this.configForContext(ctx);
    const issue = await this.callLinear<LinearIssue>("get_issue", { id: issueId.trim() }, config);
    const identifier = issue.id || issueId.trim();
    await this.assertIssueCanStart(issue, config, ctx);
    const state = readState(config.repoRoot);
    if (state.workers[identifier]?.status === "running") return state.workers[identifier];

    const slug = slugify(`${identifier}-${issue.title}`);
    const branch = `${config.branchPrefix}/${slug}`;
    const windowName = slug.slice(0, 48);

    try {
      const worktree = await this.ensureWorktree(config, branch);
      const promptPath = path.join(worktree, ".pi-linear-prompt.md");
      fs.writeFileSync(promptPath, buildWorkerPrompt(issue, branch, worktree));

      const { index } = await this.startTmuxPi(config, windowName, worktree, identifier, promptPath);
      const worker: WorkerState = {
        identifier,
        title: issue.title,
        branch,
        worktree,
        repoRoot: config.repoRoot,
        tmuxSession: config.tmuxSession,
        tmuxWindow: windowName,
        tmuxWindowIndex: index,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      state.workers[identifier] = worker;
      writeState(state, config.repoRoot);

      await this.markLinearRunning(config, issue, worker).catch((error) => {
        ctx?.ui?.notify?.(`Worker started, but Linear update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
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
      await this.callLinear("save_comment", {
        issueId: identifier,
        body: `Pi worker failed to start.\n\n\`\`\`\n${worker.error}\n\`\`\``,
      }, config).catch(() => {});
      throw error;
    }
  }

  configForContext(ctx?: ExtensionContext): Config {
    const repoRoot = this.resolveRepoRoot(ctx?.cwd);
    const config = readConfig(repoRoot);
    if (repoRoot && config.repoRoot !== repoRoot) {
      config.repoRoot = repoRoot;
      writeConfig(config);
      this.log(ctx, `Using repo root ${repoRoot}.`);
    }
    return config;
  }

  private resolveRepoRoot(cwd?: string): string | undefined {
    if (!cwd) return undefined;
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
    } catch {
      return cwd;
    }
  }

  private async assertIssueCanStart(issue: LinearIssue, config: Config, ctx?: ExtensionContext): Promise<void> {
    const labels = issueLabels(issue);
    if (!labels.includes(config.triggerLabel)) {
      throw new Error(`Refusing to start ${issue.id}: missing required label ${config.triggerLabel}.`);
    }

    if (!config.requireAssigneeMe) return;

    const response = await this.callLinear<LinearIssue[] | { issues?: LinearIssue[] }>("list_issues", {
      label: config.triggerLabel,
      assignee: config.watchAssignee,
      limit: 250,
      orderBy: "updatedAt",
      includeArchived: false,
    }, config);
    const assignedIssues = Array.isArray(response) ? response : response.issues || [];
    const isAssignedToAllowedUser = assignedIssues.some((assignedIssue) => assignedIssue.id === issue.id);
    if (!isAssignedToAllowedUser) {
      this.log(ctx, `Security check blocked ${issue.id}: not assigned to ${config.watchAssignee}.`, "warning");
      throw new Error(`Refusing to start ${issue.id}: issue must be assigned to ${config.watchAssignee}.`);
    }
  }

  private async callLinear<T>(toolName: string, args: Record<string, unknown>, providedConfig?: Config): Promise<T> {
    const config = providedConfig ?? readConfig();
    const mcpConfig = loadMcpConfig(undefined, config.repoRoot);
    const definition = mcpConfig.mcpServers[config.mcpServer] as ServerEntry | undefined;
    if (!definition) throw new Error(`MCP server "${config.mcpServer}" not found in MCP config.`);

    const connection = await this.manager.connect(config.mcpServer, definition);
    if (connection.status === "needs-auth") {
      throw new Error(`Linear MCP needs auth. In Pi, run: mcp({ action: "auth-start", server: "${config.mcpServer}" })`);
    }

    const originalName = toolName.startsWith(`${config.mcpServer}_`)
      ? toolName.slice(config.mcpServer.length + 1)
      : toolName;

    this.manager.touch(config.mcpServer);
    this.manager.incrementInFlight(config.mcpServer);
    try {
      const result = await connection.client.callTool({ name: originalName, arguments: args });
      if ((result as any).isError) throw new Error(JSON.stringify(result));
      return parseMcpJson<T>(result);
    } finally {
      this.manager.decrementInFlight(config.mcpServer);
      this.manager.touch(config.mcpServer);
    }
  }

  private async ensureWorktree(config: Config, branch: string): Promise<string> {
    const branchExists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: config.repoRoot })
      .then(() => true)
      .catch(() => false);

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
    const match = Array.isArray(entries) ? entries.find((entry) => entry.branch === branch) : undefined;
    if (match?.path) return match.path;
    throw new Error(`Created/switched branch ${branch}, but could not resolve worktree path.`);
  }

  private async resolveBaseBranch(config: Config): Promise<string> {
    const candidates = [
      config.baseBranch,
      await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: config.repoRoot, encoding: "utf8" })
        .then(({ stdout }) => stdout.trim())
        .catch(() => ""),
      "origin/main",
      "origin/master",
      "main",
      "master",
    ].filter(Boolean);

    for (const candidate of Array.from(new Set(candidates))) {
      const exists = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd: config.repoRoot })
        .then(() => true)
        .catch(() => false);
      if (exists) return candidate;
    }

    throw new Error(`Could not resolve base branch. Tried: ${candidates.join(", ")}`);
  }

  private async startTmuxPi(config: Config, windowName: string, worktree: string, issueId: string, promptPath: string): Promise<{ index: string }> {
    await execFileAsync("tmux", ["has-session", "-t", config.tmuxSession]).catch(async () => {
      await execFileAsync("tmux", ["new-session", "-d", "-s", config.tmuxSession, "-n", "anchor"]);
    });

    const baseIndex = Number((await execFileAsync("tmux", ["show-options", "-gv", "base-index"])).stdout.trim() || "0");
    const windows = (await execFileAsync("tmux", ["list-windows", "-t", config.tmuxSession, "-F", "#I"])).stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
    let index = baseIndex;
    while (windows.includes(index)) index++;

    const shellCommand = `export PATH=${shellQuote(config.nodeBinDir)}:\$PATH; LINEAR_PI_WORKER=1 ${shellQuote(config.piCommand)} --name ${shellQuote(issueId)} "$(cat ${shellQuote(promptPath)})"; exec \${SHELL:-zsh} -l`;
    await execFileAsync("tmux", [
      "new-window",
      "-t", `${config.tmuxSession}:${index}`,
      "-n", windowName,
      "-c", worktree,
      `bash -lc ${shellQuote(shellCommand)}`,
    ]);
    return { index: String(index) };
  }

  private async markLinearRunning(config: Config, issue: LinearIssue, worker: WorkerState) {
    const labels = Array.from(new Set([...issueLabels(issue), config.triggerLabel, config.runningLabel]));
    await (async () => {
      if (config.setInProgress) {
        await this.callLinear("save_issue", { id: worker.identifier, state: config.inProgressState, labels }, config).catch(async () => {
          await this.callLinear("save_issue", { id: worker.identifier, labels }, config);
        });
      } else {
        await this.callLinear("save_issue", { id: worker.identifier, labels }, config);
      }
    })().catch(() => {
      // Labels may not exist yet, or the workflow state name may differ. The startup
      // comment below is the critical feedback path, so do not fail the worker here.
    });
    await this.callLinear("save_comment", {
      issueId: worker.identifier,
      body: `Started Pi worker:\n\n- repo: \`${config.repoRoot}\`\n- tmux: \`${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}\`\n- branch: \`${worker.branch}\`\n- worktree: \`${worker.worktree}\``,
    }, config);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildWorkerPrompt(issue: LinearIssue, branch: string, worktree: string): string {
  return `You are implementing Linear issue ${issue.id}.

Title:
${issue.title}

Description:
${issue.description || "(no description)"}

URL:
${issue.url || "(no url)"}

Branch:
${branch}

Worktree:
${worktree}

Instructions:
- You are running in a dedicated git worktree. Keep changes scoped to this issue.
- Inspect existing code patterns before editing.
- Add or update tests when appropriate.
- Run relevant formatting, linting, typecheck, and tests for affected packages before finishing.
- Use Linear MCP tools if you need to reread or update the issue.
- If blocked, comment on the Linear issue with the blocker and stop.
`;
}

export default function linearPiOrchestratorExtension(pi: ExtensionAPI) {
  const orchestrator = new LinearPiOrchestrator();
  let watchBarTimer: NodeJS.Timeout | undefined;
  let watchBarEnabled = true;

  function refreshWatchBar(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const config = orchestrator.configForContext(ctx);
    watchBarEnabled = readWatchBarPreference(config.repoRoot) ?? true;
    if (!watchBarEnabled) {
      ctx.ui.setStatus(WATCH_STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(WATCH_STATUS_KEY, orchestrator.statusBarText(config));
  }

  function stopWatchBar(ctx?: ExtensionContext) {
    if (watchBarTimer) clearInterval(watchBarTimer);
    watchBarTimer = undefined;
    if (ctx?.hasUI) ctx.ui.setStatus(WATCH_STATUS_KEY, undefined);
  }

  function startWatchBar(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (watchBarTimer) clearInterval(watchBarTimer);
    refreshWatchBar(ctx);
    watchBarTimer = setInterval(() => refreshWatchBar(ctx), WATCH_BAR_INTERVAL_MS);
  }

  async function setWatchBarEnabled(ctx: ExtensionContext, enabled: boolean) {
    const config = orchestrator.configForContext(ctx);
    watchBarEnabled = enabled;
    const saved = writeWatchBarPreference(enabled, config.repoRoot);
    if (!saved) ctx.ui.notify("Could not save Linear watch bar preference", "warning");
    if (enabled) {
      startWatchBar(ctx);
      ctx.ui.notify(`Linear watch bar enabled: ${orchestrator.statusBarText(config)}`, "info");
      return;
    }
    stopWatchBar(ctx);
    ctx.ui.notify("Linear watch bar disabled", "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    const config = orchestrator.configForContext(ctx);
    watchBarEnabled = readWatchBarPreference(config.repoRoot) ?? true;
    if (watchBarEnabled) startWatchBar(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWatchBar();
    await orchestrator.shutdown();
  });

  pi.registerCommand("linear-start", {
    description: "Start a tmux/Pi worker for a Linear issue via Linear MCP. Usage: /linear-start ABC-123",
    handler: async (args, ctx) => {
      const issueId = args.trim();
      if (!issueId) {
        ctx.ui.notify("Usage: /linear-start ABC-123", "error");
        return;
      }
      ctx.ui.notify(`Starting Linear Pi worker for ${issueId}...`, "info");
      const worker = await orchestrator.startIssue(issueId, ctx);
      ctx.ui.notify(`Started ${worker.identifier}: ${worker.tmuxSession}:${worker.tmuxWindowIndex || "?"}:${worker.tmuxWindow}`, "info");
    },
  });

  pi.registerCommand("linear-watch", {
    description: "Manage Linear label watcher. Usage: /linear-watch start [label] | foreground [label] | once [label] | stop | status | logs",
    getArgumentCompletions: (prefix) => ["start", "foreground", "stop", "once", "status", "logs"].filter((x) => x.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [action = "status", maybeLabel] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "start") {
        if (process.env.LINEAR_PI_WORKER === "1") {
          ctx.ui.notify("Refusing to start watcher in a spawned worker session.", "warning");
          return;
        }
        ctx.ui.notify(orchestrator.startDaemon(ctx, maybeLabel), "info");
        refreshWatchBar(ctx);
        return;
      }
      if (action === "foreground") {
        orchestrator.startWatch(ctx, maybeLabel);
        ctx.ui.notify(orchestrator.statusSummary(orchestrator.configForContext(ctx)), "info");
        refreshWatchBar(ctx);
        return;
      }
      if (action === "stop") {
        const daemonMessage = orchestrator.stopDaemon(orchestrator.configForContext(ctx));
        orchestrator.stopWatch(ctx);
        ctx.ui.notify(daemonMessage || "Linear watcher stopped.", "info");
        refreshWatchBar(ctx);
        return;
      }
      if (action === "once") {
        ctx.ui.notify(await orchestrator.watchOnce(ctx, maybeLabel), "info");
        return;
      }
      if (action === "logs") {
        const config = orchestrator.configForContext(ctx);
        ctx.ui.notify(orchestrator.getLogs(config), "info");
        return;
      }
      ctx.ui.notify(orchestrator.statusSummary(orchestrator.configForContext(ctx), true), "info");
    },
  });

  pi.registerCommand("linear-watch-bar", {
    description: "Show or hide Linear watcher status in the footer. Usage: /linear-watch-bar [on|off|toggle|status|refresh]",
    getArgumentCompletions: (prefix) => ["on", "off", "toggle", "status", "refresh"].filter((x) => x.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "refresh";
      if (["on", "enable", "enabled"].includes(action)) {
        await setWatchBarEnabled(ctx, true);
        return;
      }
      if (["off", "disable", "disabled"].includes(action)) {
        await setWatchBarEnabled(ctx, false);
        return;
      }
      if (action === "toggle") {
        await setWatchBarEnabled(ctx, !watchBarEnabled);
        return;
      }
      if (action === "status") {
        refreshWatchBar(ctx);
        const config = orchestrator.configForContext(ctx);
        ctx.ui.notify(`Linear watch bar: ${watchBarEnabled ? "enabled" : "disabled"}\n${orchestrator.statusBarText(config)}`, "info");
        return;
      }
      if (action !== "refresh") {
        ctx.ui.notify("Usage: /linear-watch-bar [on|off|toggle|status|refresh]", "warning");
        return;
      }
      refreshWatchBar(ctx);
      ctx.ui.notify(orchestrator.statusBarText(orchestrator.configForContext(ctx)), "info");
    },
  });

  pi.registerCommand("linear-cleanup", {
    description: "Clean tmux windows and wt worktrees. Usage: /linear-cleanup to pick a running worker, or /linear-cleanup [done|all|CRM-123]",
    getArgumentCompletions: (prefix) => {
      const workers = orchestrator.listWorkers(undefined, readConfig(process.cwd()));
      return ["done", "all", ...workers.map((worker) => worker.identifier), ...workers.map((worker) => worker.branch)]
        .filter((x) => x.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify(await orchestrator.cleanupInteractive(ctx), "info");
        return;
      }

      ctx.ui.notify(`Cleaning Linear Pi workers: ${target}...`, "info");
      const result = await orchestrator.cleanup(target, ctx);
      ctx.ui.notify(result, "info");
    },
  });

  pi.registerCommand("linear-status", {
    description: "Show Linear Pi worker state",
    handler: async (_args, ctx) => {
      const state = readState(orchestrator.configForContext(ctx).repoRoot);
      const workers = Object.values(state.workers);
      if (!workers.length) {
        ctx.ui.notify("No Linear Pi workers recorded.", "info");
        return;
      }
      const text = workers
        .map((w) => `${w.identifier} [${w.status}]\n- tmux: ${w.tmuxSession}:${w.tmuxWindowIndex || "?"}:${w.tmuxWindow}\n- branch: ${w.branch}\n- worktree: ${w.worktree}${w.error ? `\n- error: ${w.error}` : ""}`)
        .join("\n\n");
      ctx.ui.notify(text, "info");
    },
  });
}

async function runDaemon() {
  ensureConfigDir();
  const config = readConfig(process.env.LINEAR_PI_REPO_ROOT || process.cwd());
  fs.mkdirSync(repoScopeDir(config.repoRoot), { recursive: true });
  fs.writeFileSync(pidPath(config.repoRoot), String(process.pid));
  const orchestrator = new LinearPiOrchestrator();
  const cleanup = async () => {
    fs.rmSync(pidPath(config.repoRoot), { force: true });
    await orchestrator.shutdown();
  };
  process.once("SIGTERM", () => void cleanup().finally(() => process.exit(0)));
  process.once("SIGINT", () => void cleanup().finally(() => process.exit(0)));
  orchestrator.startWatch(undefined);
}

if (process.argv.includes("--linear-pi-daemon")) {
  void runDaemon().catch((error) => {
    ensureConfigDir();
    const config = readConfig(process.env.LINEAR_PI_REPO_ROOT || process.cwd());
    fs.mkdirSync(repoScopeDir(config.repoRoot), { recursive: true });
    fs.appendFileSync(logPath(config.repoRoot), `${new Date().toISOString()} ERROR Daemon failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
