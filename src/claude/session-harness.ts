import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { WorkerCompletion, WorkerHandle, WorkerHandoffResult, WorkerHandoffSpec, WorkerPromptSpec, WorkerTurn } from "../domain/index.js";
import type { HarnessLaunchRequest, HarnessPlugin } from "../plugins/index.js";

/** Reserved, automatically composed harness id used by the claude.* actions. */
export const CLAUDE_SESSION_HARNESS_ID = "__claude_session";

const execFileAsync = promisify(execFile);

const harnessConfigSchema = z.object({}).strict().default({});

/** Harness-specific launch input carried on `HarnessLaunchRequest.harnessInput`. */
type ClaudeHarnessInput = {
  worktree?: string;
  name?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
};

type ClaudeTurnRecord = {
  workerId: string;
  turnId: string;
  pid: number;
  startedAt: string;
  log: string;
  status: "running" | "succeeded" | "failed";
  result?: string;
  structuredOutput?: unknown;
  costUsd?: number;
  durationMs?: number;
  error?: string;
  /** Killed by a forced handoff: the user took over, so the turn does not fail the chain. */
  cancelledForHandoff?: boolean;
};

/** Durable, on-disk state for one persistent Claude Code CLI session. */
type ClaudeSessionRecord = {
  workerId: string;
  sessionId: string;
  worktree?: string;
  name?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  /** Working directory every turn is spawned from (the repository root). */
  cwd: string;
  itemId?: string;
  repository?: string;
  firstTurnStarted: boolean;
  activeTurnId?: string;
  /** The worktree path Claude reports on its `system`/`init` line, used to unlock it before handoff. */
  worktreePath?: string;
  turns: Record<string, ClaudeTurnRecord>;
  handoff?: WorkerHandoffResult;
  stopped?: boolean;
};

type ClaudeResultLine = {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  structured_output?: unknown;
};

export interface ClaudeSessionHarnessOptions {
  /** Per-project directory the harness persists session and turn state under. */
  stateDirectory: string;
  /** The `claude` executable to spawn. Defaults to `"claude"` on PATH. */
  command?: string;
  /** Opens a `claude://` URL. Defaults to `open -g` (macOS) or `cmd /c start` (Windows). Inject a fake in tests. */
  openUrl?: (url: string) => Promise<void>;
  /** Directory the Claude CLI registers its live sessions in. Defaults to `~/.claude/sessions`. */
  sessionsDirectory?: string;
  now?: () => Date;
  /** Defaults to `process.platform`; inject to exercise handoff's platform gate in tests. */
  platform?: NodeJS.Platform;
  /** Minimum spacing enforced between consecutive handoffs. Defaults to 1500ms. */
  handoffSpacingMs?: number;
  /** Grace period between SIGTERM and SIGKILL when stopping a running turn. Defaults to 5000ms. */
  killGraceMs?: number;
  /** Injectable delay, so tests need not wait on real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs a `git` command against a worktree path. Injectable so tests never touch a real repository. */
  runGit?: (args: readonly string[], cwd: string) => Promise<void>;
}

/**
 * Owns persistent `claude -p` CLI sessions: each `sendPrompt` spawns one
 * detached turn against a durable session id, and `handoff` transfers that
 * session to the Claude desktop app for human review. Unlike the Codex App
 * Server harness, there is no long-lived child process to reattach to — every
 * turn's own process exits when it finishes, and state lives entirely in the
 * per-worker JSON file this harness reads and writes.
 */
export class ClaudeSessionHarness implements HarnessPlugin<z.infer<typeof harnessConfigSchema>> {
  readonly kind = "harness" as const;
  readonly use = CLAUDE_SESSION_HARNESS_ID;
  readonly configSchema = harnessConfigSchema;
  readonly presentation = {
    name: "Claude Code Session",
    description: "Run a persistent Claude Code CLI session that can later be handed off to the desktop app.",
    category: "Workers",
    icon: "bot",
    color: "#d97757",
  };

  private readonly command: string;
  private readonly openUrlImpl: ((url: string) => Promise<void>) | undefined;
  private readonly sessionsDirectory: string;
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;
  private readonly handoffSpacingMs: number;
  private readonly killGraceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly runGit: (args: readonly string[], cwd: string) => Promise<void>;
  private readonly stateDirectoryPath: string;

  private handoffLock: Promise<void> = Promise.resolve();
  private lastHandoffAt = 0;

  constructor(options: ClaudeSessionHarnessOptions) {
    this.stateDirectoryPath = options.stateDirectory;
    this.command = options.command ?? "claude";
    this.openUrlImpl = options.openUrl;
    this.sessionsDirectory = options.sessionsDirectory ?? join(homedir(), ".claude", "sessions");
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
    this.handoffSpacingMs = options.handoffSpacingMs ?? 1_500;
    this.killGraceMs = options.killGraceMs ?? 5_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.runGit = options.runGit ?? ((args, cwd) => execFileAsync("git", [...args], { cwd }).then(() => undefined));
  }

  async launch(request: HarnessLaunchRequest<z.infer<typeof harnessConfigSchema>>): Promise<WorkerHandle> {
    const input = parseHarnessInput(request.harnessInput);
    const sessionId = randomUUID();
    const record: ClaudeSessionRecord = {
      workerId: request.workerId,
      sessionId,
      worktree: input.worktree,
      name: input.name,
      permissionMode: input.permissionMode,
      model: input.model ?? request.model,
      effort: input.effort ?? request.reasoningEffort,
      cwd: request.workspace.path,
      itemId: request.item.id,
      repository: request.repository.id,
      firstTurnStarted: false,
      turns: {},
    };
    this.writeSession(record);
    return {
      id: request.workerId || `claude-session-${randomUUID()}`,
      startedAt: this.now().toISOString(),
      metadata: {
        persistent: true,
        // Unlike a tmux window the user may keep working in after the chain
        // finishes, a headless Claude session job has no purpose once its
        // workflow run is done: opt in to the generic post-run sweep so an
        // un-handed-off session doesn't run forever and block later runs.
        stopWithWorkflowRun: true,
        workspace: request.workspace.path,
        claudeSession: {
          sessionId,
          worktree: record.worktree,
          name: record.name,
          permissionMode: record.permissionMode,
          model: record.model,
          effort: record.effort,
          cwd: record.cwd,
        },
      },
    };
  }

  async sendPrompt(worker: WorkerHandle, spec: WorkerPromptSpec): Promise<WorkerTurn> {
    const record = this.requireSession(worker);
    if (record.handoff) throw new Error(`Worker ${worker.id} has already been handed off to the Claude app.`);
    const active = record.activeTurnId ? record.turns[record.activeTurnId] : undefined;
    if (active && !this.isTurnFinished(active) && this.isAlive(active.pid)) {
      throw new Error(`Worker ${worker.id} already has a running Claude turn (${active.turnId}).`);
    }

    const turnId = randomUUID();
    const isFirstTurn = !record.firstTurnStarted;
    const args = this.buildArgs(record, spec, isFirstTurn);
    const dir = this.turnsDirectory(worker.id);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${turnId}.jsonl`);
    const fd = openSync(logPath, "a");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TASK_RELAY_WORKER_ID: worker.id,
      ...(record.itemId ? { TASK_RELAY_ITEM_ID: record.itemId } : {}),
      ...(record.repository ? { TASK_RELAY_REPOSITORY: record.repository } : {}),
    };
    let child: ReturnType<typeof spawn>;
    // The child keeps its own copy of the log descriptor; the parent must not leak one per turn.
    try { child = spawn(this.command, args, { cwd: record.cwd, stdio: ["ignore", fd, fd], detached: true, env }); }
    finally { closeSync(fd); }
    child.on("error", () => undefined);
    child.unref();
    if (typeof child.pid !== "number") throw new Error("Claude did not report a process id.");

    const turn: ClaudeTurnRecord = { workerId: worker.id, turnId, pid: child.pid, startedAt: this.now().toISOString(), log: logPath, status: "running" };
    record.turns[turnId] = turn;
    record.activeTurnId = turnId;
    record.firstTurnStarted = true;
    this.writeSession(record);
    return { workerId: worker.id, turnId, status: "running" };
  }

  async turn(worker: WorkerHandle, turnId: string): Promise<WorkerTurn> {
    const record = this.requireSession(worker);
    const turn = record.turns[turnId];
    if (!turn) throw new Error(`Worker ${worker.id} has no Claude turn ${turnId}.`);
    if (this.isTurnFinished(turn)) return toWorkerTurn(turn);

    const parsed = this.parseLog(turn.log);
    if (parsed.worktreePath && !record.worktreePath) record.worktreePath = parsed.worktreePath;

    if (parsed.result) {
      // The `claude -p` process may still be exiting for a moment after it
      // writes its result line; wait for it to actually die so the session
      // registry entry is gone before this turn (and any handoff) proceeds.
      if (this.isAlive(turn.pid)) {
        this.writeSession(record);
        return { workerId: worker.id, turnId, status: "running" };
      }
      const failed = Boolean(parsed.result.is_error);
      turn.status = failed ? "failed" : "succeeded";
      turn.result = parsed.result.result;
      turn.structuredOutput = parsed.result.structured_output;
      turn.costUsd = parsed.result.total_cost_usd;
      turn.durationMs = parsed.result.duration_ms;
      if (failed) turn.error = parsed.result.result || `Claude turn ${turnId} ${parsed.result.subtype ?? "failed"}.`;
      if (record.activeTurnId === turnId) record.activeTurnId = undefined;
      this.writeSession(record);
      return toWorkerTurn(turn);
    }

    if (this.isAlive(turn.pid)) {
      this.writeSession(record);
      return { workerId: worker.id, turnId, status: "running" };
    }

    turn.status = "failed";
    turn.error = "Claude exited without a result.";
    if (record.activeTurnId === turnId) record.activeTurnId = undefined;
    this.writeSession(record);
    return toWorkerTurn(turn);
  }

  async wait(): Promise<WorkerCompletion | undefined> {
    // A Claude session's completion is observed one turn at a time via `turn`,
    // never by blocking on the whole conversation.
    return undefined;
  }

  async reconcile(worker: WorkerHandle): Promise<WorkerCompletion | undefined> {
    const record = this.tryReadSession(worker.id);
    if (!record?.handoff) return undefined;
    const lastTurn = lastFinishedTurn(record);
    return {
      status: record.handoff.chainStatus,
      ...(record.handoff.chainStatus === "failed" ? { error: lastTurn?.error ?? "The Claude session's chain finished with a failure." } : {}),
    };
  }

  async stop(worker: WorkerHandle): Promise<void> {
    const record = this.tryReadSession(worker.id);
    if (!record) return;
    const active = record.activeTurnId ? record.turns[record.activeTurnId] : undefined;
    if (active && !this.isTurnFinished(active)) await this.killTurn(active, "SIGTERM");
    record.stopped = true;
    this.writeSession(record);
  }

  async handoff(worker: WorkerHandle, spec?: WorkerHandoffSpec): Promise<WorkerHandoffResult> {
    const record = this.requireSession(worker);
    if (record.handoff) return record.handoff;
    return this.serializeHandoff(() => this.performHandoff(worker, record, spec));
  }

  private async performHandoff(worker: WorkerHandle, record: ClaudeSessionRecord, spec?: WorkerHandoffSpec): Promise<WorkerHandoffResult> {
    // A concurrent handoff for this same worker may have finished while this
    // call waited its turn behind the spacing lock.
    if (record.handoff) return record.handoff;

    const active = record.activeTurnId ? record.turns[record.activeTurnId] : undefined;
    const running = Boolean(active) && !this.isTurnFinished(active!) && this.isAlive(active!.pid);
    if (running && !spec?.force) {
      throw new Error(`Worker ${worker.id} has a Claude turn in progress. Pass force to hand it off anyway.`);
    }
    if (running && active) {
      await this.killTurn(active, "SIGKILL");
      active.status = "failed";
      active.error = "Cancelled for handoff.";
      active.cancelledForHandoff = true;
      record.activeTurnId = undefined;
      this.writeSession(record);
    }

    if (this.hasLiveSessionEntry(record.sessionId)) {
      // The `claude` CLI can take a moment to remove its registry entry after
      // its process exits; poll briefly instead of failing the handoff outright.
      const pollIntervalMs = 500;
      const maxAttempts = Math.ceil(15_000 / pollIntervalMs);
      let attempt = 0;
      while (this.hasLiveSessionEntry(record.sessionId) && attempt < maxAttempts) {
        await this.sleep(pollIntervalMs);
        attempt += 1;
      }
      if (this.hasLiveSessionEntry(record.sessionId)) {
        throw new Error(`Claude session ${record.sessionId} is still registered as a live CLI process. Stop it before handing off.`);
      }
    }

    if (record.worktreePath) {
      await this.runGit(["worktree", "unlock", record.worktreePath], record.cwd).catch(() => undefined);
    }

    if (this.platform !== "darwin" && this.platform !== "win32") {
      throw new Error("The Claude app handoff needs macOS or Windows.");
    }
    await this.openUrl(`claude://resume?session=${record.sessionId}`);

    const lastTurn = lastFinishedTurn(record);
    const chainStatus: "succeeded" | "failed" = Object.values(record.turns)
      .some((turn) => turn.status === "failed" && !turn.cancelledForHandoff) ? "failed" : "succeeded";
    const result: WorkerHandoffResult = {
      target: "claude-app",
      handedOffAt: this.now().toISOString(),
      chainStatus,
      link: `claude://claude.ai/epitaxy/local_${record.sessionId}`,
      appSessionId: `local_${record.sessionId}`,
      ...(lastTurn?.result ? { lastResult: lastTurn.result.slice(0, 4_000) } : {}),
    };
    record.handoff = result;
    this.writeSession(record);
    return result;
  }

  /** Enforces a minimum spacing between the desktop app's `claude://resume` imports. */
  private async serializeHandoff<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.handoffLock.then(async () => {
      const wait = this.handoffSpacingMs - (this.now().getTime() - this.lastHandoffAt);
      if (this.lastHandoffAt > 0 && wait > 0) await this.sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastHandoffAt = this.now().getTime();
      }
    });
    this.handoffLock = run.then(() => undefined, () => undefined);
    return run;
  }

  private async openUrl(url: string): Promise<void> {
    if (this.openUrlImpl) { await this.openUrlImpl(url); return; }
    if (this.platform === "darwin") { await execFileAsync("open", ["-g", url]); return; }
    await execFileAsync("cmd", ["/c", "start", "", url]);
  }

  private async killTurn(turn: ClaudeTurnRecord, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    if (!this.isAlive(turn.pid)) return;
    try { process.kill(turn.pid, signal); } catch { return; }
    if (signal === "SIGKILL") return;
    await this.sleep(this.killGraceMs);
    if (this.isAlive(turn.pid)) {
      try { process.kill(turn.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }

  private hasLiveSessionEntry(sessionId: string): boolean {
    if (!existsSync(this.sessionsDirectory)) return false;
    for (const file of readdirSync(this.sessionsDirectory)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(this.sessionsDirectory, file), "utf8");
        const parsed = JSON.parse(raw) as { pid?: unknown; sessionId?: unknown };
        if (parsed.sessionId === sessionId && typeof parsed.pid === "number" && this.isAlive(parsed.pid)) return true;
      } catch { /* ignore malformed or racing registry entries */ }
    }
    return false;
  }

  private isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }

  private isTurnFinished(turn: ClaudeTurnRecord): boolean {
    return turn.status !== "running";
  }

  private buildArgs(record: ClaudeSessionRecord, spec: WorkerPromptSpec, isFirstTurn: boolean): string[] {
    const args: string[] = [];
    if (isFirstTurn) {
      if (record.worktree) args.push("--worktree", record.worktree);
      args.push("--session-id", record.sessionId);
      if (record.name) args.push("--name", record.name);
    } else {
      args.push("--resume", record.sessionId);
    }
    args.push("-p");
    const model = spec.model ?? record.model;
    const effort = spec.effort ?? record.effort;
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (record.permissionMode) args.push("--permission-mode", record.permissionMode);
    args.push("--permission-prompts", "none");
    args.push("--output-format", "stream-json", "--verbose");
    if (spec.jsonSchema) args.push("--json-schema", JSON.stringify(spec.jsonSchema));
    args.push(spec.prompt);
    return args;
  }

  private parseLog(logPath: string): { worktreePath?: string; result?: ClaudeResultLine } {
    if (!existsSync(logPath)) return {};
    let worktreePath: string | undefined;
    let result: ClaudeResultLine | undefined;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line) as Record<string, unknown>; }
      catch { continue; }
      if (parsed.type === "system" && parsed.subtype === "init" && typeof parsed.cwd === "string") worktreePath = parsed.cwd;
      if (parsed.type === "result") result = parsed as unknown as ClaudeResultLine;
    }
    return { worktreePath, result };
  }

  private requireSession(worker: WorkerHandle): ClaudeSessionRecord {
    // Always re-read: a CLI or dashboard handoff in another process may have changed the file.
    const record = this.tryReadSession(worker.id);
    if (!record) throw new Error(`Worker ${worker.id} does not contain a resumable Claude session.`);
    return record;
  }

  private tryReadSession(workerId: string): ClaudeSessionRecord | undefined {
    const file = this.sessionFile(workerId);
    if (!existsSync(file)) return undefined;
    try { return JSON.parse(readFileSync(file, "utf8")) as ClaudeSessionRecord; }
    catch { return undefined; }
  }

  private writeSession(record: ClaudeSessionRecord): void {
    mkdirSync(this.sessionDir(record.workerId), { recursive: true });
    writeFileSync(this.sessionFile(record.workerId), JSON.stringify(record, null, 2));
  }

  private sessionDir(workerId: string): string { return join(this.stateDirectoryPath, "claude-sessions", workerId); }
  private turnsDirectory(workerId: string): string { return join(this.sessionDir(workerId), "turns"); }
  private sessionFile(workerId: string): string { return join(this.sessionDir(workerId), "session.json"); }
}

function parseHarnessInput(value: Record<string, unknown> | undefined): ClaudeHarnessInput {
  if (!value) return {};
  return {
    worktree: typeof value.worktree === "string" ? value.worktree : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    permissionMode: typeof value.permissionMode === "string" ? value.permissionMode : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    effort: typeof value.effort === "string" ? value.effort : undefined,
  };
}

function toWorkerTurn(turn: ClaudeTurnRecord): WorkerTurn {
  return {
    workerId: turn.workerId,
    turnId: turn.turnId,
    status: turn.status,
    ...(turn.result !== undefined ? { result: turn.result } : {}),
    ...(turn.structuredOutput !== undefined ? { structuredOutput: turn.structuredOutput } : {}),
    ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
    ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
    ...(turn.error !== undefined ? { error: turn.error } : {}),
  };
}

function lastFinishedTurn(record: ClaudeSessionRecord): ClaudeTurnRecord | undefined {
  const finished = Object.values(record.turns).filter((turn) => turn.status !== "running");
  finished.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return finished[0];
}
