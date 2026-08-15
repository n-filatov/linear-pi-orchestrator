import { execa } from "execa";
import type { AgentExecution, AgentExecutionAdapter, AgentExecutionResult } from "../agents/types.js";
import type { WorkerHandle } from "../domain/index.js";

export type DirectProcessAdapterOptions = { extendEnv?: boolean; windowsHide?: boolean };

/** Starts an agent directly and returns as soon as the child has a PID. */
export class DirectProcessAdapter implements AgentExecutionAdapter {
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
    // Deliberately observe exit so a detached worker failure is not unhandled.
    void child.catch(() => undefined);
    return { pid: child.pid };
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
    const { index, window } = await this.nextWindow(execution.workerName);
    const command = tmuxShellCommand(execution);
    await execa("tmux", [
      "new-window",
      "-d",
      "-t", `${this.options.session}:${index}`,
      "-n", window,
      "-c", execution.cwd,
      this.options.shell ?? "sh",
      "-lc",
      command,
    ], { env: this.options.environment });
    const pane = await execa("tmux", ["display-message", "-p", "-t", `${this.options.session}:${index}`, "#{pane_pid}"], { reject: false });
    const parsedPid = Number(pane.stdout.trim());
    return {
      ...(Number.isInteger(parsedPid) && parsedPid > 0 ? { pid: parsedPid } : {}),
      tmux: { session: this.options.session, window, index: String(index) },
    };
  }

  async stop(worker: WorkerHandle): Promise<void> {
    const tmux = recordMetadata(worker, "tmux");
    const session = typeof tmux.session === "string" ? tmux.session : undefined;
    const index = typeof tmux.index === "string" ? tmux.index : undefined;
    const window = typeof tmux.window === "string" ? tmux.window : undefined;
    if (!session) return;
    const target = index ? `${session}:${index}` : window ? `${session}:${window}` : undefined;
    if (target) await execa("tmux", ["kill-window", "-t", target], { reject: false });
  }

  private async ensureSession(): Promise<void> {
    const existing = await execa("tmux", ["has-session", "-t", this.options.session], { reject: false });
    if (existing.exitCode === 0) return;
    await execa("tmux", ["new-session", "-d", "-s", this.options.session, "-n", "anchor"]);
  }

  private async nextWindow(workerName: string): Promise<{ index: number; window: string }> {
    const [base, windows] = await Promise.all([
      execa("tmux", ["show-options", "-gv", "base-index"]),
      execa("tmux", ["list-windows", "-t", this.options.session, "-F", "#I"]),
    ]);
    const occupied = new Set(windows.stdout.split("\n").filter(Boolean).map(Number));
    let index = Number(base.stdout.trim() || "0");
    while (occupied.has(index)) index += 1;
    return { index, window: sanitizeWindowName(workerName) };
  }
}

function tmuxShellCommand(execution: AgentExecution): string {
  const env = Object.entries(execution.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      return `${key}=${shellQuote(value)}`;
    });
  const command = [shellQuote(execution.command), ...execution.args.map(shellQuote)].join(" ");
  const stdin = execution.stdin === undefined ? "" : `printf %s ${shellQuote(execution.stdin)} | `;
  // Keep the window open after a command exits for inspection, matching the
  // old persistent-worker behaviour without exposing unquoted data to a shell.
  return `${env.join(" ")}${env.length ? " " : ""}${stdin}${command}; exec \${SHELL:-sh} -l`;
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
