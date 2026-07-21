import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Config, AgentPreset, LinearIssue } from "../types.ts";
import { isIssueDoneOrCanceled } from "../types.ts";

export const CONFIG_DIR = path.join(os.homedir(), ".pi", "linear-pi");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const REPOS_DIR = path.join(CONFIG_DIR, "repos");

export function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function repoScopeDir(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 10);
  return path.join(REPOS_DIR, `${base}-${hash}`);
}

export function configPath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "config.json"); }
export function statePath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "state.json"); }
export function lockPath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "state.lock"); }
export function logPath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "watch.log"); }
export function pidPath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "watch.pid"); }
export function barPrefPath(repoRoot: string): string { return path.join(repoScopeDir(repoRoot), "watch-bar.json"); }

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
    .filter((e) => e.startsWith("v"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((e) => path.join(root, e, "bin"));
}

export function defaultConfig(repoRoot = process.env.LINEAR_PI_REPO_ROOT || process.cwd()): Config {
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
    agent: (process.env.LINEAR_PI_AGENT || "pi").toLowerCase(),
    nodeBinDir: findCompatibleNodeBinDir(),
    issueLimit: Number(process.env.LINEAR_PI_ISSUE_LIMIT || 50),
    requireAssigneeMe: process.env.LINEAR_PI_REQUIRE_ASSIGNEE_ME !== "false",
    watchAssignee: process.env.LINEAR_PI_WATCH_ASSIGNEE || "me",
    setInProgress: process.env.LINEAR_PI_SET_IN_PROGRESS !== "false",
    inProgressState: process.env.LINEAR_PI_IN_PROGRESS_STATE || "In Progress",
    resourceCheckEnabled: process.env.LINEAR_PI_RESOURCE_CHECK_ENABLED !== "false",
    minFreeMemoryMb: Number(process.env.LINEAR_PI_MIN_FREE_MEMORY_MB || 1024),
    minFreeMemoryPercent: Number(process.env.LINEAR_PI_MIN_FREE_MEMORY_PERCENT || 10),
    maxLoadAveragePerCpu: Number(process.env.LINEAR_PI_MAX_LOAD_AVERAGE_PER_CPU || 2),
  };
}

function readJsonFile<T extends object>(filePath: string): Partial<T> {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
  } catch {
    return {};
  }
}

export function readConfig(repoRootHint?: string): Config {
  ensureConfigDir();
  const globalConfig = readJsonFile<Config>(CONFIG_PATH);
  const repoRoot = path.resolve(
    repoRootHint
    || process.env.LINEAR_PI_REPO_ROOT
    || (typeof globalConfig.repoRoot === "string" ? globalConfig.repoRoot : "")
    || process.cwd()
  );
  const scopedPath = configPath(repoRoot);
  const scopedConfig = readJsonFile<Config>(scopedPath);
  const config = { ...defaultConfig(repoRoot), ...globalConfig, ...scopedConfig, repoRoot };
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(repoRoot), null, 2));
  if (!fs.existsSync(scopedPath)) writeConfig(config);
  return config;
}

export function writeConfig(config: Config) {
  ensureConfigDir();
  const scopedDir = repoScopeDir(config.repoRoot);
  fs.mkdirSync(scopedDir, { recursive: true });
  fs.writeFileSync(configPath(config.repoRoot), JSON.stringify(config, null, 2));
}

export function setTriggerLabel(label: string, repoRoot?: string): Config {
  const config = readConfig(repoRoot);
  config.triggerLabel = label;
  writeConfig(config);
  return config;
}

export const DEFAULT_AGENT = "pi";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export const AGENT_PRESETS: Record<string, AgentPreset> = {
  pi: {
    id: "pi",
    label: "Pi",
    defaultCommand: "pi",
    buildInvocation: (binary, issueId, prompt) => `${shellQuote(binary)} --name ${shellQuote(issueId)} "$(cat ${prompt})"`,
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    defaultCommand: "claude",
    buildInvocation: (binary, _issueId, prompt) => `${shellQuote(binary)} "$(cat ${prompt})"`,
    binaryCandidates: () => [
      path.join(os.homedir(), ".claude", "local", "claude"),
      path.join(os.homedir(), ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    defaultCommand: "codex",
    buildInvocation: (binary, _issueId, prompt) => `${shellQuote(binary)} "$(cat ${prompt})"`,
    binaryCandidates: () => [
      "/opt/homebrew/bin/codex",
      path.join(os.homedir(), ".local", "bin", "codex"),
      "/usr/local/bin/codex",
    ],
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    defaultCommand: "opencode",
    buildInvocation: (binary, _issueId, prompt) => `${shellQuote(binary)} run "$(cat ${prompt})"`,
    binaryCandidates: () => [
      path.join(os.homedir(), ".opencode", "bin", "opencode"),
      path.join(os.homedir(), ".local", "bin", "opencode"),
      "/opt/homebrew/bin/opencode",
      "/usr/local/bin/opencode",
    ],
  },
};

/** Resolves a bare command name to an absolute path by probing PATH plus extra candidates. */
function findExecutable(name: string, extraCandidates: string[] = []): string {
  if (name.includes("/")) return name;
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const candidates = [...pathDirs.map((dir) => path.join(dir, name)), ...extraCandidates];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return name;
}

export function resolveAgentPreset(agent: string | undefined): AgentPreset {
  const key = (agent || DEFAULT_AGENT).toLowerCase();
  return AGENT_PRESETS[key] || AGENT_PRESETS[DEFAULT_AGENT];
}

export function resolveAgentBinary(config: Config, preset: AgentPreset): string {
  if (process.env.LINEAR_PI_AGENT_COMMAND) return process.env.LINEAR_PI_AGENT_COMMAND;
  const perAgentEnv = process.env[`LINEAR_PI_${preset.id.toUpperCase()}_COMMAND`];
  if (perAgentEnv) return perAgentEnv;
  // Backward compatibility: piCommand overrides the pi binary when using the pi agent.
  if (preset.id === "pi" && config.piCommand && config.piCommand !== "pi") return config.piCommand;
  // Resolve to an absolute path so the worker's `bash -lc` shell finds it even when
  // the command is only available via a shell alias/function (e.g. fish `claude`).
  return findExecutable(preset.defaultCommand, preset.binaryCandidates?.() ?? []);
}

export function setAgent(agent: string, repoRoot?: string): Config {
  const preset = resolveAgentPreset(agent);
  const config = readConfig(repoRoot);
  config.agent = preset.id;
  writeConfig(config);
  return config;
}

export function readWatchBarPreference(repoRoot = readConfig().repoRoot): boolean | undefined {
  try {
    const filePath = barPrefPath(repoRoot);
    if (!fs.existsSync(filePath)) return undefined;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { enabled?: unknown };
    return typeof data.enabled === "boolean" ? data.enabled : undefined;
  } catch {
    return undefined;
  }
}

export function writeWatchBarPreference(enabled: boolean, repoRoot = readConfig().repoRoot): boolean {
  try {
    ensureConfigDir();
    fs.mkdirSync(repoScopeDir(repoRoot), { recursive: true });
    fs.writeFileSync(barPrefPath(repoRoot), `${JSON.stringify({ enabled }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function resolveRepoRoot(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

export function slugify(input: string, max = 64): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "") || "linear-task";
}

/** Max total length of a tmux window name we generate. */
const WINDOW_NAME_MAX = 45;

/**
 * Short uppercase code for a Linear issue's workflow state, shown as a `[CODE]`
 * prefix in the tmux window name. Keyed off the status *name* first because
 * "In Progress" and "In Review" usually share `statusType: "started"`.
 */
export function statusCode(issue: LinearIssue): string {
  if (isIssueDoneOrCanceled(issue)) {
    return issue.statusType === "canceled" || issue.status === "Canceled" ? "CXL" : "DONE";
  }
  const name = (issue.status || "").toLowerCase();
  if (name.includes("review")) return "REV";
  if (name.includes("progress") || issue.statusType === "started") return "WIP";
  if (name === "todo" || issue.statusType === "unstarted") return "TODO";
  if (issue.statusType === "backlog") return "BKLG";
  if (issue.statusType === "triage") return "TRI";
  return (issue.status || "").replace(/[^a-zA-Z0-9]+/g, "").slice(0, 4).toUpperCase() || "?";
}

/**
 * Build the tmux window name: `[CODE] REF title-slug`, capped to
 * WINDOW_NAME_MAX by truncating only the title portion. The prefix
 * (brackets, ref) is preserved as-is — tmux allows brackets/spaces/uppercase.
 */
export function buildWindowName(issue: LinearIssue): string {
  const ref = issue.identifier || issue.id;
  const prefix = `[${statusCode(issue)}] ${ref} `;
  const titleBudget = Math.max(0, WINDOW_NAME_MAX - prefix.length);
  const title = slugify(issue.title, titleBudget || 1);
  return `${prefix}${title}`.trim();
}
