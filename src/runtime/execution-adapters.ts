import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import type { AgentExecution, AgentExecutionAdapter, AgentExecutionResult } from "../agents/types.js";
import type { WorkerCompletion, WorkerHandle } from "../domain/index.js";

export type DirectProcessAdapterOptions = {
  extendEnv?: boolean;
  windowsHide?: boolean;
  /** Grace period before an unresponsive worker is force-terminated. */
  stopTimeoutMs?: number;
};

/** Starts an agent directly and returns as soon as the child has a PID. */
export class DirectProcessAdapter implements AgentExecutionAdapter {
  private readonly children = new Map<number, ReturnType<typeof execa>>();
  constructor(private readonly options: DirectProcessAdapterOptions = {}) {}

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
    return { pid: child.pid };
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
export class TmuxExecutionAdapter implements AgentExecutionAdapter {
  constructor(private readonly options: TmuxExecutionAdapterOptions) {}

  async execute(execution: AgentExecution): Promise<AgentExecutionResult> {
    await this.ensureSession();
    const window = sanitizeWindowName(execution.workerName);
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
    const parsedPid = Number(panePid);
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
      tmux: { session: this.options.session, window: actualWindow, index, target, exitKey },
    };
  }

  async wait(worker: WorkerHandle): Promise<WorkerCompletion | undefined> {
    const tmux = tmuxMetadata(worker);
    if (!tmux.session || !tmux.target || !tmux.exitKey) return undefined;
    for (;;) {
      const completion = await this.exitCompletion(tmux.session, tmux.exitKey);
      if (completion) return completion;
      if (!await this.windowExists(tmux.session, tmux.target)) {
        // Window is gone. Retry exitCompletion — the shell may have written the
        // exit marker (tmux option or temp file) just as the window was closing.
        await delay(50);
        const final = await this.exitCompletion(tmux.session, tmux.exitKey);
        return final ?? { status: "failed", error: "Tmux worker exited without recording an exit status." };
      }
      // A detached tmux launch must not keep `relay once` alive solely for
      // polling. Its persisted exit marker is reconciled by the next relay.
      await delay(200, undefined, { ref: false });
    }
  }

  async reconcile(worker: WorkerHandle): Promise<WorkerCompletion | undefined> {
    const tmux = tmuxMetadata(worker);
    if (!tmux.session || !tmux.target) return { status: "failed", error: "Persisted tmux worker has no target." };
    const completion = tmux.exitKey ? await this.exitCompletion(tmux.session, tmux.exitKey) : undefined;
    if (completion) return completion;
    return await this.windowExists(tmux.session, tmux.target)
      ? undefined
      : { status: "failed", error: "Tmux worker was no longer running when the relay restarted." };
  }

  async stop(worker: WorkerHandle): Promise<void> {
    const tmux = recordMetadata(worker, "tmux");
    const session = typeof tmux.session === "string" ? tmux.session : undefined;
    const targetId = typeof tmux.target === "string" ? tmux.target : undefined;
    const index = typeof tmux.index === "string" ? tmux.index : undefined;
    const window = typeof tmux.window === "string" ? tmux.window : undefined;
    if (!session) throw new Error(`Worker ${worker.id} has no tmux session metadata.`);
    const target = targetId || (index ? `${session}:${index}` : window ? `${session}:${window}` : undefined);
    if (!target) throw new Error(`Worker ${worker.id} has no tmux window target metadata.`);
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
    const tmux = recordMetadata(worker, "tmux");
    const session = typeof tmux.session === "string" ? tmux.session : undefined;
    const target = typeof tmux.target === "string" ? tmux.target : undefined;
    const index = typeof tmux.index === "string" ? tmux.index : undefined;
    const window = typeof tmux.window === "string" ? tmux.window : undefined;
    if (!session || !target) throw new Error(`Worker ${worker.id} has no attachable tmux target.`);
    if (!await this.windowExists(session, target)) throw new Error(`Tmux worker ${worker.id} is no longer available.`);

    if (process.env.TMUX) {
      await execa("tmux", ["switch-client", "-t", target], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return;
    }
    const attachTarget = `${session}:${index ?? window ?? ""}`.replace(/:$/, "");
    await execa("tmux", ["attach-session", "-t", attachTarget], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
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

    const buffer = `task-relay-prompt-${randomUUID()}`;
    const loaded = await execa("tmux", ["load-buffer", "-b", buffer, "-"], { input, reject: false });
    if (loaded.exitCode !== 0) {
      throw new Error(`Could not load the interactive prompt into tmux: ${loaded.stderr.trim() || `tmux exited with code ${loaded.exitCode}`}`);
    }
    const pasted = await execa("tmux", ["paste-buffer", "-p", "-d", "-b", buffer, "-t", target], { reject: false });
    if (pasted.exitCode !== 0) {
      await execa("tmux", ["delete-buffer", "-b", buffer], { reject: false });
      throw new Error(`Could not paste the interactive prompt into worker: ${pasted.stderr.trim() || `tmux exited with code ${pasted.exitCode}`}`);
    }
    // The TUI needs a moment to commit the bracketed paste into its input state
    // before it will treat a following Enter as "submit" rather than dropping it.
    const submitDelayMs = this.options.interactiveSubmitDelayMs ?? 150;
    if (submitDelayMs > 0) await delay(submitDelayMs);
    const submitted = await execa("tmux", ["send-keys", "-t", target, "Enter"], { reject: false });
    if (submitted.exitCode !== 0) {
      throw new Error(`Could not submit the interactive prompt to worker: ${submitted.stderr.trim() || `tmux exited with code ${submitted.exitCode}`}`);
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

  private async windowExists(_session: string, target: string): Promise<boolean> {
    // This accepts a window id, session:index, or session:name and therefore
    // remains compatible with worker metadata written by earlier versions.
    const window = await execa("tmux", ["display-message", "-p", "-t", target, "#{window_id}"], { reject: false });
    return window.exitCode === 0 && window.stdout.trim().length > 0;
  }
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

function recordMetadata(worker: WorkerHandle, key: string): Record<string, unknown> {
  const value = worker.metadata?.[key];
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function tmuxMetadata(worker: WorkerHandle): { session?: string; target?: string; exitKey?: string } {
  const tmux = recordMetadata(worker, "tmux");
  return {
    session: typeof tmux.session === "string" ? tmux.session : undefined,
    target: typeof tmux.target === "string" ? tmux.target : undefined,
    exitKey: typeof tmux.exitKey === "string" ? tmux.exitKey : undefined,
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
