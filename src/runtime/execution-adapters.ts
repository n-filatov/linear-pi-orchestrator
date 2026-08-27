import { randomUUID } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import type { AgentExecution, AgentExecutionAdapter, AgentExecutionResult } from "../agents/types.js";
import type {
  WorkerChildHandle,
  WorkerChildSpec,
  WorkerCompletion,
  WorkerHandle,
  WorkerInputSpec,
  WorkerRuntime,
  WorkerRuntimeCapabilities,
} from "../domain/index.js";

export type DirectProcessAdapterOptions = {
  extendEnv?: boolean;
  windowsHide?: boolean;
  /** Grace period before an unresponsive worker is force-terminated. */
  stopTimeoutMs?: number;
};

/** Starts an agent directly and returns as soon as the child has a PID. */
export class DirectProcessAdapter implements AgentExecutionAdapter, WorkerRuntime {
  private readonly children = new Map<number, ReturnType<typeof execa>>();
  constructor(private readonly options: DirectProcessAdapterOptions = {}) {}

  /**
   * A detached process has no terminal Relay owns, so none of the live-worker
   * verbs can be honoured. The capabilities are reported truthfully instead of
   * failing late, and every verb explains the fix rather than the symptom.
   */
  readonly capabilities: WorkerRuntimeCapabilities = { children: false, input: false, capture: false };

  get runtime(): WorkerRuntime { return this; }

  async open(_worker: WorkerHandle, spec: WorkerChildSpec): Promise<WorkerChildHandle> {
    throw new Error(`Opening a ${spec.open} beside a worker requires execution.adapter: tmux.`);
  }

  async sendInput(): Promise<void> {
    throw new Error("Sending input to a running worker requires execution.adapter: tmux.");
  }

  async capture(): Promise<string> {
    throw new Error("Reading a worker's output requires execution.adapter: tmux.");
  }

  async exists(worker: WorkerHandle): Promise<boolean> {
    const pid = numberMetadata(worker, "pid");
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  async closeChild(): Promise<void> {
    throw new Error("The direct-process adapter never opens worker children.");
  }

  async execute(execution: AgentExecution): Promise<AgentExecutionResult> {
    if (execution.interactiveInput !== undefined) {
      throw new Error("Interactive workers require the tmux execution adapter.");
    }
    const child = execa(execution.command, [...execution.args], {
      cwd: execution.cwd,
      env: execution.env,
      stdin: execution.stdin === undefined ? "ignore" : "pipe",
      stdout: "inherit",
      stderr: "inherit",
      reject: false,
      ...this.options,
    });
    if (execution.stdin !== undefined) child.stdin?.end(execution.stdin);
    if (child.pid) this.children.set(child.pid, child);
    return { pid: child.pid, workerId: execution.workerId };
  }

  async wait(worker: WorkerHandle): Promise<WorkerCompletion | undefined> {
    const pid = numberMetadata(worker, "pid");
    if (!pid) return undefined;
    const child = this.children.get(pid);
    if (!child) return undefined;
    const result = await child;
    this.children.delete(pid);
    return result.exitCode === 0
      ? { status: "succeeded" }
      : { status: "failed", error: `Worker exited with ${result.exitCode === undefined ? "an unknown status" : `code ${result.exitCode}`}.` };
  }

  async reconcile(worker: WorkerHandle): Promise<WorkerCompletion | undefined> {
    const pid = numberMetadata(worker, "pid");
    if (!pid) return { status: "failed", error: "Persisted direct-process worker has no PID." };
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "ESRCH") return { status: "failed", error: "Worker was no longer running when the relay restarted." };
      throw error;
    }
  }

  async stop(worker: WorkerHandle): Promise<void> {
    const pid = numberMetadata(worker, "pid");
    if (!pid) return;
    if (!signalProcess(pid, "SIGTERM")) return;
    if (await waitForProcessExit(pid, this.options.stopTimeoutMs ?? 5_000)) {
      this.children.delete(pid);
      return;
    }
    if (!signalProcess(pid, "SIGKILL")) return;
    if (!await waitForProcessExit(pid, 1_000)) {
      throw new Error(`Worker process ${pid} did not exit after SIGTERM and SIGKILL.`);
    }
    this.children.delete(pid);
  }
}

export type TmuxExecutionAdapterOptions = {
  session: string;
  shell?: string;
  environment?: Readonly<Record<string, string>>;
  stopTimeoutMs?: number;
  /** Delay before pasting into a newly started terminal UI. Defaults to 500ms. */
  interactivePromptDelayMs?: number;
  /** Delay between pasting the prompt and submitting it with Enter. Defaults to 150ms. */
  interactiveSubmitDelayMs?: number;
};

/**
 * tmux is the sole shell boundary. The actual agent command remains argv until
 * it is safely quoted for tmux's `sh -lc` payload.
 */
export class TmuxExecutionAdapter implements AgentExecutionAdapter, WorkerRuntime {
  constructor(private readonly options: TmuxExecutionAdapterOptions) {}

  /** tmux can do everything Relay asks of a live worker. */
  readonly capabilities: WorkerRuntimeCapabilities = { children: true, input: true, capture: true };

  get runtime(): WorkerRuntime { return this; }

  async execute(execution: AgentExecution): Promise<AgentExecutionResult> {
    await this.ensureSession();
    const window = sanitizeWindowName(execution.workerName);
    const issue = execution.issue ?? execution.workerName;
    const exitKey = `task-relay-exit-${randomUUID()}`;
    const command = tmuxShellCommand(execution, exitKey);
    const created = await execa("tmux", [
      "new-window",
      "-d",
      "-P",
      "-F", "#{window_id}\t#{window_index}\t#{window_name}\t#{pane_pid}",
      "-t", this.options.session,
      "-n", window,
      "-c", execution.cwd,
      this.options.shell ?? "sh",
      "-lc",
      command,
    ], { env: this.options.environment });
    const [target = "", index = "", actualWindow = window, panePid = ""] = created.stdout.trim().split("\t");
    // CommandAgentLauncher always supplies the registry generation id. The
    // target-derived fallback only preserves compatibility for direct callers
    // of this adapter that predate durable worker identities.
    const workerId = execution.workerId ?? `tmux-${target}`;
    const parsedPid = Number(panePid);
    try {
      await this.tagWorkerWindow(target, workerId, issue);
    } catch (error) {
      await execa("tmux", ["kill-window", "-t", target], { reject: false });
      await execa("tmux", ["set-option", "-gu", `@${exitKey}`], { reject: false });
      throw error;
    }
    if (execution.interactiveInput !== undefined) {
      try {
        await this.prepareInteractiveWindow(target);
        await this.deliverInteractiveInput(target, execution.interactiveInput);
      } catch (error) {
        await execa("tmux", ["kill-window", "-t", target], { reject: false });
        await execa("tmux", ["set-option", "-gu", `@${exitKey}`], { reject: false });
        throw error;
      }
    }
    return {
      ...(Number.isInteger(parsedPid) && parsedPid > 0 ? { pid: parsedPid } : {}),
      workerId,
      tmux: { session: this.options.session, window: actualWindow, index, target, exitKey, workerId, issue },
    };
  }

  async wait(worker: WorkerHandle): Promise<WorkerCompletion | undefined> {
    const tmux = tmuxMetadata(worker);
    const session = tmux.session ?? this.options.session;
    if (!tmux.exitKey) return undefined;
    for (;;) {
      const completion = await this.exitCompletion(session, tmux.exitKey);
      if (completion) return completion;
      const target = await this.resolveWorkerTarget(worker);
      if (!target) {
        // Window is gone. Retry exitCompletion — the shell may have written the
        // exit marker (tmux option or temp file) just as the window was closing.
        await delay(50);
        const final = await this.exitCompletion(session, tmux.exitKey);
        return final ?? { status: "failed", error: "Tmux worker exited without recording an exit status." };
      }
      // A detached tmux launch must not keep `relay once` alive solely for
      // polling. Its persisted exit marker is reconciled by the next relay.
      await delay(200, undefined, { ref: false });
    }
  }

  async reconcile(worker: WorkerHandle): Promise<WorkerCompletion | undefined> {
    const tmux = tmuxMetadata(worker);
    const session = tmux.session ?? this.options.session;
    if (!tmux.target && !tmux.workerId && !tmux.window) return { status: "failed", error: "Persisted tmux worker has no target." };
    const completion = tmux.exitKey ? await this.exitCompletion(session, tmux.exitKey) : undefined;
    if (completion) return completion;
    return await this.resolveWorkerTarget(worker)
      ? undefined
      : { status: "failed", error: "Tmux worker was no longer running when the relay restarted." };
  }

  async stop(worker: WorkerHandle): Promise<void> {
    const tmux = tmuxMetadata(worker);
    const session = tmux.session ?? this.options.session;
    if (!session) throw new Error(`Worker ${worker.id} has no tmux session metadata.`);
    const target = await this.resolveWorkerTarget(worker);
    if (!target) throw new Error(`Could not safely find tmux worker ${worker.id}; its persisted target is stale and no tagged window or matching workspace pane was found.`);
    const removed = await execa("tmux", ["kill-window", "-t", target], { reject: false });
    if (removed.exitCode !== 0 && await this.windowExists(session, target)) {
      throw new Error(`Could not stop tmux worker ${worker.id}: ${removed.stderr.trim() || `tmux exited with code ${removed.exitCode}`}`);
    }
    const deadline = Date.now() + (this.options.stopTimeoutMs ?? 5_000);
    while (await this.windowExists(session, target)) {
      if (Date.now() >= deadline) throw new Error(`Tmux worker ${worker.id} did not stop within the configured timeout.`);
      await delay(50);
    }
  }

  async attach(worker: WorkerHandle): Promise<void> {
    const tmux = tmuxMetadata(worker);
    const session = tmux.session ?? this.options.session;
    const target = await this.resolveWorkerTarget(worker);
    if (!target) throw new Error(`Tmux worker ${worker.id} is no longer available.`);

    if (process.env.TMUX) {
      await execa("tmux", ["switch-client", "-t", target], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return;
    }
    // attach-session accepts a session target, not a window id. Select the
    // rebound window first so attaching from a fresh terminal opens the
    // worker rather than whichever window was active most recently.
    const selected = await execa("tmux", ["select-window", "-t", target], { reject: false });
    if (selected.exitCode !== 0) throw new Error(`Could not select tmux worker ${worker.id}: ${selected.stderr.trim() || `tmux exited with code ${selected.exitCode}`}`);
    await execa("tmux", ["attach-session", "-t", session], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  }

  // ── WorkerRuntime ─────────────────────────────────────────────────────────

  async open(worker: WorkerHandle, spec: WorkerChildSpec): Promise<WorkerChildHandle> {
    const target = await this.requireTarget(worker);
    const cwd = spec.cwd ?? stringMetadata(worker, "workspace");
    if (!cwd) throw new Error(`Worker ${worker.id} has no workspace directory to open a ${spec.open} in.`);
    if (!await this.aliveTarget(target)) throw new Error(`Worker ${worker.id} is no longer running, so Relay cannot open a ${spec.open} beside it.`);

    const payload = tmuxShellPayload(spec.command, spec.args ?? [], spec.env ?? {});
    const name = sanitizeWindowName(spec.name ?? spec.command);
    const created = spec.open === "pane"
      ? await execa("tmux", [
        "split-window", "-d", "-P",
        "-F", "#{pane_id}",
        spec.direction === "horizontal" ? "-h" : "-v",
        "-t", target,
        "-c", cwd,
        this.options.shell ?? "sh", "-lc", payload,
      ], { reject: false })
      : await execa("tmux", [
        "new-window", "-d", "-P",
        "-F", "#{window_id}",
        "-t", this.sessionOf(worker),
        "-n", name,
        "-c", cwd,
        this.options.shell ?? "sh", "-lc", payload,
      ], { reject: false });

    if (created.exitCode !== 0) {
      throw new Error(`Could not open a ${spec.open} for worker ${worker.id}: ${created.stderr.trim() || `tmux exited with code ${created.exitCode}`}`);
    }
    const childTarget = created.stdout.trim();
    if (!childTarget) throw new Error(`tmux opened a ${spec.open} for worker ${worker.id} but did not report its id.`);

    // Keep the output readable after the command finishes. A worker-scoped pane
    // exists so a person can see it; letting tmux reap it defeats the purpose.
    await execa("tmux", ["set-option", "-t", childTarget, spec.open === "pane" ? "-p" : "-w", "remain-on-exit", "on"], { reject: false });
    if (spec.open === "pane" && spec.name) {
      await execa("tmux", ["select-pane", "-t", childTarget, "-T", spec.name], { reject: false });
    }

    return {
      id: `${worker.id}:${name}`,
      kind: spec.open,
      target: childTarget,
      name: spec.name ?? name,
      command: [spec.command, ...(spec.args ?? [])].join(" "),
      startedAt: new Date().toISOString(),
    };
  }

  async sendInput(worker: WorkerHandle, spec: WorkerInputSpec): Promise<void> {
    const target = spec.child ?? await this.requireTarget(worker);
    if (!await this.aliveTarget(target)) throw new Error(`Worker ${worker.id} is no longer running, so Relay cannot send input to it.`);
    await this.pasteInto(target, spec.text, spec.submit !== false);
  }

  async capture(worker: WorkerHandle, options: { child?: string; lines?: number } = {}): Promise<string> {
    const target = options.child ?? await this.requireTarget(worker);
    const args = ["capture-pane", "-p", "-t", target];
    if (options.lines && options.lines > 0) args.push("-S", `-${options.lines}`);
    const captured = await execa("tmux", args, { reject: false });
    if (captured.exitCode !== 0) {
      throw new Error(`Could not read output from worker ${worker.id}: ${captured.stderr.trim() || `tmux exited with code ${captured.exitCode}`}`);
    }
    return captured.stdout;
  }

  async exists(worker: WorkerHandle, child?: string): Promise<boolean> {
    const target = child ?? await this.resolveWorkerTarget(worker);
    return target ? await this.aliveTarget(target) : false;
  }

  async closeChild(_worker: WorkerHandle, child: WorkerChildHandle): Promise<void> {
    const command = child.kind === "pane" ? "kill-pane" : "kill-window";
    const removed = await execa("tmux", [command, "-t", child.target], { reject: false });
    if (removed.exitCode !== 0 && await this.aliveTarget(child.target)) {
      throw new Error(`Could not close ${child.kind} ${child.target}: ${removed.stderr.trim() || `tmux exited with code ${removed.exitCode}`}`);
    }
  }

  private async requireTarget(worker: WorkerHandle): Promise<string> {
    const target = await this.resolveWorkerTarget(worker);
    if (!target) throw new Error(`Worker ${worker.id} has no tmux target that is live. Only workers launched by the tmux adapter can be controlled.`);
    return target;
  }

  private sessionOf(worker: WorkerHandle): string {
    return tmuxMetadata(worker).session ?? this.options.session;
  }

  /**
   * Locate a persisted worker without trusting a recycled tmux window id.
   * New records use a generation-id option. Old records are only rebound when the
   * session/window name and a pane's working directory both agree.
   */
  private async resolveWorkerTarget(worker: WorkerHandle): Promise<string | undefined> {
    const tmux = tmuxMetadata(worker);
    const session = tmux.session ?? this.options.session;
    if (!session) return undefined;

    if (tmux.target && await this.windowExists(session, tmux.target)) {
      if (!tmux.workerId || await this.windowOptionEquals(tmux.target, "@task_relay_worker_id", tmux.workerId)) {
        return tmux.target;
      }
    }

    if (tmux.workerId) {
      const tagged = await this.windowsWithOption(session, "@task_relay_worker_id", tmux.workerId);
      if (tagged.length === 1) return this.rebind(worker, tagged[0]!);
      // Ambiguous identities are never selected by name or path: doing so
      // could attach to or kill an unrelated operator-owned window.
      if (tagged.length > 1) return undefined;
    }

    const workspace = stringMetadata(worker, "workspace");
    if ((!tmux.window && !tmux.issue) || !workspace) return undefined;
    const candidates = await this.windowsMatchingLegacyMetadata(session, tmux.window ?? "", workspace, tmux.issue);
    return candidates.length === 1 ? this.rebind(worker, candidates[0]!) : undefined;
  }

  private async rebind(worker: WorkerHandle, target: string): Promise<string> {
    const tmux = tmuxMetadata(worker);
    if (tmux.workerId) await this.tagWorkerWindow(target, tmux.workerId, tmux.issue ?? worker.id);
    const resolved = await execa("tmux", ["display-message", "-p", "-t", target, "#{window_id}\t#{window_index}\t#{window_name}"], { reject: false });
    if (resolved.exitCode !== 0) return target;
    const [windowId, index, window] = resolved.stdout.trim().split("\t");
    const persisted = recordMetadata(worker, "tmux");
    if (windowId) persisted.target = windowId;
    if (index !== undefined) persisted.index = index;
    if (window) persisted.window = window;
    return windowId || target;
  }

  private async windowsWithOption(session: string, option: string, value: string): Promise<string[]> {
    const listed = await execa("tmux", ["list-windows", "-t", session, "-F", `#{window_id}\t#{${option}}`], { reject: false });
    if (listed.exitCode !== 0) return [];
    return listed.stdout.split("\n")
      .map((line) => line.split("\t"))
      .filter(([target, optionValue]) => Boolean(target) && optionValue === value)
      .map(([target]) => target!);
  }

  private async windowsMatchingLegacyMetadata(session: string, windowName: string, workspace: string, issue?: string): Promise<string[]> {
    const listed = await execa("tmux", ["list-panes", "-s", "-t", session, "-F", "#{window_id}\t#{window_name}\t#{pane_current_path}"], { reject: false });
    if (listed.exitCode !== 0) return [];
    const issueName = issue ? sanitizeWindowName(issue) : undefined;
    const canonicalWorkspace = await realpath(workspace).catch(() => workspace);
    const matches = await Promise.all(listed.stdout.split("\n").map(async (line) => {
      const [target, name, cwd] = line.split("\t");
      if (!target || !cwd || !(name === windowName || Boolean(issueName && (name === issueName || name?.startsWith(`${issueName}-`))))) return undefined;
      const canonicalCwd = await realpath(cwd).catch(() => cwd);
      return canonicalCwd === canonicalWorkspace ? target : undefined;
    }));
    return [...new Set(matches.filter((target): target is string => Boolean(target)))];
  }

  private async tagWorkerWindow(target: string, workerId: string, issue: string): Promise<void> {
    if (!target) throw new Error("tmux created a worker window but did not report its id.");
    for (const [option, value] of [["@task_relay_worker_id", workerId], ["@task_relay_issue", issue]] as const) {
      const tagged = await execa("tmux", ["set-window-option", "-t", target, option, value], { reject: false });
      if (tagged.exitCode !== 0) {
        throw new Error(`Could not persist tmux worker identity: ${tagged.stderr.trim() || `tmux exited with code ${tagged.exitCode}`}`);
      }
    }
  }

  private async windowOptionEquals(target: string, option: string, expected: string): Promise<boolean> {
    const shown = await execa("tmux", ["show-window-options", "-v", "-t", target, option], { reject: false });
    return shown.exitCode === 0 && shown.stdout.trim() === expected;
  }

  /** True for a window id, pane id, or `session:index` that tmux still knows. */
  private async aliveTarget(target: string): Promise<boolean> {
    const shown = await execa("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"], { reject: false });
    return shown.exitCode === 0 && shown.stdout.trim().length > 0;
  }

  private async ensureSession(): Promise<void> {
    const existing = await execa("tmux", ["has-session", "-t", this.options.session], { reject: false });
    if (existing.exitCode === 0) return;
    const created = await execa("tmux", ["new-session", "-d", "-s", this.options.session, "-n", "anchor"], { reject: false });
    if (created.exitCode !== 0) {
      const afterRace = await execa("tmux", ["has-session", "-t", this.options.session], { reject: false });
      if (afterRace.exitCode !== 0) throw new Error(`Could not create tmux session ${this.options.session}.`);
    }
  }

  private async prepareInteractiveWindow(target: string): Promise<void> {
    const configured = await execa("tmux", ["set-window-option", "-t", target, "remain-on-exit", "on"], { reject: false });
    if (configured.exitCode !== 0) {
      throw new Error(`Could not retain interactive tmux window: ${configured.stderr.trim() || `tmux exited with code ${configured.exitCode}`}`);
    }
  }

  private async deliverInteractiveInput(target: string, input: string): Promise<void> {
    const promptDelayMs = this.options.interactivePromptDelayMs ?? 500;
    if (promptDelayMs > 0) await delay(promptDelayMs);
    if (!await this.windowExists(this.options.session, target)) {
      throw new Error("Interactive worker exited before Relay could deliver its prompt.");
    }
    await this.pasteInto(target, input, true);
  }

  /**
   * Bracketed paste followed by an optional Enter. This is the only way to put
   * text into a terminal UI that owns the tty, and it is shared by the launch
   * prompt and by later `worker-send` instructions.
   */
  private async pasteInto(target: string, input: string, submit: boolean): Promise<void> {
    const buffer = `task-relay-prompt-${randomUUID()}`;
    const loaded = await execa("tmux", ["load-buffer", "-b", buffer, "-"], { input, reject: false });
    if (loaded.exitCode !== 0) {
      throw new Error(`Could not load the prompt into tmux: ${loaded.stderr.trim() || `tmux exited with code ${loaded.exitCode}`}`);
    }
    const pasted = await execa("tmux", ["paste-buffer", "-p", "-d", "-b", buffer, "-t", target], { reject: false });
    if (pasted.exitCode !== 0) {
      await execa("tmux", ["delete-buffer", "-b", buffer], { reject: false });
      throw new Error(`Could not paste the prompt into worker: ${pasted.stderr.trim() || `tmux exited with code ${pasted.exitCode}`}`);
    }
    if (!submit) return;
    // The TUI needs a moment to commit the bracketed paste into its input state
    // before it will treat a following Enter as "submit" rather than dropping it.
    // This now covers `worker-send` as well, which pastes into the same TUI.
    const submitDelayMs = this.options.interactiveSubmitDelayMs ?? 150;
    if (submitDelayMs > 0) await delay(submitDelayMs);
    const submitted = await execa("tmux", ["send-keys", "-t", target, "Enter"], { reject: false });
    if (submitted.exitCode !== 0) {
      throw new Error(`Could not submit the prompt to worker: ${submitted.stderr.trim() || `tmux exited with code ${submitted.exitCode}`}`);
    }
  }

  private async exitCompletion(session: string, exitKey: string): Promise<WorkerCompletion | undefined> {
    const option = await execa("tmux", ["show-options", "-gv", `@${exitKey}`], { reject: false });
    const value = option.stdout.trim();
    if (option.exitCode === 0 && /^-?\d+$/.test(value)) {
      await execa("tmux", ["set-option", "-gu", `@${exitKey}`], { reject: false });
      await rm(join(tmpdir(), exitKey), { force: true });
      return value === "0" ? { status: "succeeded" } : { status: "failed", error: `Worker exited with code ${value}.` };
    }
    // Fallback: temp file written by the shell command. This survives session
    // destruction when all windows close before the polling loop can read the option.
    try {
      const fileValue = (await readFile(join(tmpdir(), exitKey), "utf8")).trim();
      if (/^-?\d+$/.test(fileValue)) {
        await rm(join(tmpdir(), exitKey), { force: true });
        return fileValue === "0" ? { status: "succeeded" } : { status: "failed", error: `Worker exited with code ${fileValue}.` };
      }
    } catch { /* file not written yet */ }
    return undefined;
  }

  private async windowExists(session: string, target: string): Promise<boolean> {
    // This accepts a window id, session:index, or session:name and therefore
    // remains compatible with worker metadata written by earlier versions.
    const window = await execa("tmux", ["display-message", "-p", "-t", target, "#{session_name}\t#{window_id}"], { reject: false });
    const [actualSession, windowId] = window.stdout.trim().split("\t");
    return window.exitCode === 0 && actualSession === session && Boolean(windowId);
  }
}

/** argv plus environment, quoted into a single `sh -lc` payload. No interpolation. */
function tmuxShellPayload(command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): string {
  const assignments = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      return `${key}=${shellQuote(value)}`;
    });
  const argv = [shellQuote(command), ...args.map(shellQuote)].join(" ");
  return `${assignments.join(" ")}${assignments.length ? " " : ""}${argv}`;
}

function tmuxShellCommand(execution: AgentExecution, exitKey: string): string {
  const env = Object.entries(execution.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      return `${key}=${shellQuote(value)}`;
    });
  const command = [shellQuote(execution.command), ...execution.args.map(shellQuote)].join(" ");
  const stdin = execution.stdin === undefined ? "" : `printf %s ${shellQuote(execution.stdin)} | `;
  // Store the exit code before letting tmux close the window. The unique option
  // is also available to a freshly restarted relay during reconciliation.
  const exitFile = shellQuote(join(tmpdir(), exitKey));
  // Write the exit code to a temp file AND a tmux global option. The file
  // survives session destruction (both windows closing simultaneously), while
  // the option is preferred for reconciliation by a restarted relay.
  return `${env.join(" ")}${env.length ? " " : ""}${stdin}${command}; task_relay_status=$?; printf '%s' "\$task_relay_status" > ${exitFile}; tmux set-option -g @${exitKey} "\$task_relay_status"; exit "\$task_relay_status"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
}

function sanitizeWindowName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task-relay";
}

function numberMetadata(worker: WorkerHandle, key: string): number | undefined {
  const value = worker.metadata?.[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringMetadata(worker: WorkerHandle, key: string): string | undefined {
  const value = worker.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordMetadata(worker: WorkerHandle, key: string): Record<string, unknown> {
  const value = worker.metadata?.[key];
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function tmuxMetadata(worker: WorkerHandle): { session?: string; window?: string; index?: string; target?: string; exitKey?: string; workerId?: string; issue?: string } {
  const tmux = recordMetadata(worker, "tmux");
  return {
    session: typeof tmux.session === "string" ? tmux.session : undefined,
    window: typeof tmux.window === "string" ? tmux.window : undefined,
    index: typeof tmux.index === "string" ? tmux.index : undefined,
    target: typeof tmux.target === "string" ? tmux.target : undefined,
    exitKey: typeof tmux.exitKey === "string" ? tmux.exitKey : undefined,
    workerId: typeof tmux.workerId === "string" ? tmux.workerId : undefined,
    issue: typeof tmux.issue === "string" ? tmux.issue : undefined,
  };
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === "ESRCH") return true;
      throw error;
    }
    await delay(50);
  } while (Date.now() < deadline);
  return false;
}
