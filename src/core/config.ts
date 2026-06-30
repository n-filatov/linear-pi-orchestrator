import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Config, AgentPreset } from "../types.js";

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
  },
  codex: {
    id: "codex",
    label: "Codex",
    defaultCommand: "codex",
    buildInvocation: (binary, _issueId, prompt) => `${shellQuote(binary)} "$(cat ${prompt})"`,
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    defaultCommand: "opencode",
    buildInvocation: (binary, _issueId, prompt) => `${shellQuote(binary)} run "$(cat ${prompt})"`,
  },
};

export function resolveAgentPreset(agent: string | undefined): AgentPreset {
  const key = (agent || DEFAULT_AGENT).toLowerCase();
  return AGENT_PRESETS[key] || AGENT_PRESETS[DEFAULT_AGENT];
}

export function resolveAgentBinary(config: Config, preset: AgentPreset): string {
  if (process.env.LINEAR_PI_AGENT_COMMAND) return process.env.LINEAR_PI_AGENT_COMMAND;
  if (preset.id === "pi" && config.piCommand && config.piCommand !== "pi") return config.piCommand;
  return preset.defaultCommand;
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
