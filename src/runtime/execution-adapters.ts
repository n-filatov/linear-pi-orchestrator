import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import type { AgentExecution, AgentExecutionAdapter, AgentExecutionResult } from "../agents/types.js";
import type { WorkerCompletion, WorkerHandle } from "../domain/index.js";

export type DirectProcessAdapterOptions = { extendEnv?: boolean; windowsHide?: boolean };

/** Starts an agent directly and returns as soon as the child has a PID. */
export class DirectProcessAdapter implements AgentExecutionAdapter {
  private readonly children = new Map<number, ReturnType<typeof execa>>();
  constructor(private readonly options: DirectProcessAdapterOptions = {}) {}

  async execute(execution: AgentExecution): Promise<AgentExecutionResult> {
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
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ESRCH") throw error;
    }
  }
}

export type TmuxExecutionAdapterOptions = {
  session: string;
  shell?: string;
  environment?: Readonly<Record<string, string>>;
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
        return { status: "failed", error: "Tmux worker exited without recording an exit status." };
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
    if (!session) return;
    const target = targetId || (index ? `${session}:${index}` : window ? `${session}:${window}` : undefined);
    if (target) await execa("tmux", ["kill-window", "-t", target], { reject: false });
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

  private async exitCompletion(session: string, exitKey: string): Promise<WorkerCompletion | undefined> {
    const option = await execa("tmux", ["show-options", "-gv", `@${exitKey}`], { reject: false });
    const value = option.stdout.trim();
    if (option.exitCode !== 0 || !/^-?\d+$/.test(value)) return undefined;
    await execa("tmux", ["set-option", "-gu", `@${exitKey}`], { reject: false });
    return value === "0" ? { status: "succeeded" } : { status: "failed", error: `Worker exited with code ${value}.` };
  }

  private async windowExists(session: string, target: string): Promise<boolean> {
    const windows = await execa("tmux", ["list-windows", "-t", session, "-F", "#{window_id}"], { reject: false });
    return windows.exitCode === 0 && windows.stdout.split("\n").includes(target);
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
  return `${env.join(" ")}${env.length ? " " : ""}${stdin}${command}; task_relay_status=$?; tmux set-option -g @${exitKey} "\$task_relay_status"; exit "\$task_relay_status"`;
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
