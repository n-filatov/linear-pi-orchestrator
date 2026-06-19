import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
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
const STATE_PATH = path.join(CONFIG_DIR, "state.json");
const LOG_PATH = path.join(CONFIG_DIR, "watch.log");

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

function defaultConfig(): Config {
  return {
    mcpServer: process.env.LINEAR_PI_MCP_SERVER || "linear",
    triggerLabel: process.env.LINEAR_PI_TRIGGER_LABEL || "pi:implement",
    runningLabel: process.env.LINEAR_PI_RUNNING_LABEL || "pi:running",
    doneLabel: process.env.LINEAR_PI_DONE_LABEL || "pi:done",
    blockedLabel: process.env.LINEAR_PI_BLOCKED_LABEL || "pi:blocked",
    pollIntervalMs: Number(process.env.LINEAR_PI_POLL_INTERVAL_MS || 30_000),
    tmuxSession: process.env.LINEAR_PI_TMUX_SESSION || "linear-pi",
    repoRoot: process.env.LINEAR_PI_REPO_ROOT || process.cwd(),
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

function readConfig(): Config {
  ensureConfigDir();
  const base = defaultConfig();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(base, null, 2));
    return base;
  }
  return { ...base, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
}

function writeConfig(config: Config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function setTriggerLabel(label: string): Config {
  const config = readConfig();
  config.triggerLabel = label;
  writeConfig(config);
  return config;
}

function readState(): StateFile {
  ensureConfigDir();
  if (!fs.existsSync(STATE_PATH)) return { workers: {} };
  return { workers: {}, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
}

function writeState(state: StateFile) {
  ensureConfigDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
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
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    this.logs.push(line);
    this.logs = this.logs.slice(-50);
    try {
      ensureConfigDir();
      fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
    } catch {
      // Keep in-memory/status logging working even if file logging is unavailable.
    }
    ctx?.ui?.setStatus?.("linear-watch", level === "error" ? "Linear watch: error" : this.timer ? "Linear watch: running" : "Linear watch: stopped");
    ctx?.ui?.setWidget?.("linear-watch", ["Linear watch", ...this.logs.slice(-12)]);
  }

  getLogs(): string {
    return this.logs.length ? this.logs.join("\n") : `No Linear watch logs yet. Log file: ${LOG_PATH}`;
  }

  statusSummary(config = readConfig(), includeRecentLogs = false): string {
    const workers = this.listWorkers("running");
    const lines = [
      `Linear watcher: ${this.isWatching() ? "running" : "stopped"}`,
      `Label: ${config.triggerLabel}`,
      `Repo: ${config.repoRoot}`,
      `Interval: ${config.pollIntervalMs}ms`,
      `Required assignee: ${config.requireAssigneeMe ? config.watchAssignee : "disabled"}`,
      `Running workers: ${workers.length}`,
      `Logs: ${LOG_PATH}`,
      `Config: ${CONFIG_PATH}`,
      `State: ${STATE_PATH}`,
    ];
    if (includeRecentLogs) lines.push("", "Recent logs:", this.getLogs());
    return lines.join("\n");
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

  isWatching() {
    return Boolean(this.timer);
  }

  startWatch(ctx: ExtensionContext, label?: string) {
    if (label) setTriggerLabel(label);
    const config = this.configForContext(ctx);
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
        ctx.ui?.notify?.(`Linear watch failed: ${message}`, "error");
      });
    }, config.pollIntervalMs);
    void this.watchOnce(ctx);
  }

  async watchOnce(ctx: ExtensionContext, label?: string): Promise<string> {
    if (label) {
      const config = setTriggerLabel(label);
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

      const state = readState();
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

  listWorkers(status?: WorkerState["status"]): WorkerState[] {
    const workers = Object.values(readState().workers);
    return status ? workers.filter((worker) => worker.status === status) : workers;
  }

  async cleanupInteractive(ctx: ExtensionContext): Promise<string> {
    const workers = this.listWorkers("running");
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
    const config = readConfig();
    const state = readState();
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

    writeState(state);
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
      const issue = await this.callLinear<LinearIssue>("get_issue", { id: worker.identifier }).catch(() => undefined);
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
    const state = readState();
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
      writeState(state);

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
      writeState(state);
      await this.callLinear("save_comment", {
        issueId: identifier,
        body: `Pi worker failed to start.\n\n\`\`\`\n${worker.error}\n\`\`\``,
      }, config).catch(() => {});
      throw error;
    }
  }

  private configForContext(ctx?: ExtensionContext): Config {
    const config = readConfig();
    const repoRoot = this.resolveRepoRoot(ctx?.cwd);
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

  pi.on("session_shutdown", async () => {
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
    description: "Manage Linear label watcher. Usage: /linear-watch start [label] | once [label] | stop | status | logs",
    getArgumentCompletions: (prefix) => ["start", "stop", "once", "status", "logs"].filter((x) => x.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [action = "status", maybeLabel] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "start") {
        if (process.env.LINEAR_PI_WORKER === "1") {
          ctx.ui.notify("Refusing to start watcher in a spawned worker session.", "warning");
          return;
        }
        orchestrator.startWatch(ctx, maybeLabel);
        ctx.ui.notify(orchestrator.statusSummary(), "info");
        return;
      }
      if (action === "stop") {
        orchestrator.stopWatch(ctx);
        ctx.ui.notify("Linear watcher stopped.", "info");
        return;
      }
      if (action === "once") {
        ctx.ui.notify(await orchestrator.watchOnce(ctx, maybeLabel), "info");
        return;
      }
      if (action === "logs") {
        ctx.ui.notify(orchestrator.getLogs(), "info");
        return;
      }
      ctx.ui.notify(orchestrator.statusSummary(readConfig(), true), "info");
    },
  });

  pi.registerCommand("linear-cleanup", {
    description: "Clean tmux windows and wt worktrees. Usage: /linear-cleanup to pick a running worker, or /linear-cleanup [done|all|CRM-123]",
    getArgumentCompletions: (prefix) => {
      const workers = orchestrator.listWorkers();
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
      const state = readState();
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
