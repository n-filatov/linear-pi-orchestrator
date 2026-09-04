import { z } from "zod";
import type { AgentExecutionAdapter } from "../agents/types.js";
import type { WorkerCompletion, WorkerHandle } from "../domain/index.js";
import type { HarnessLaunchRequest, HarnessPlugin } from "../plugins/index.js";

/** Reserved harness behind the `tmux.create-window` action. */
export const TMUX_WINDOW_HARNESS_ID = "__tmux_window";

const configSchema = z.object({}).strict().default({});

/**
 * A shell window is a real Relay worker: it has a RunRecord, gets a durable
 * tmux tag, and is stopped by cleanup. This deliberately avoids anonymous
 * `tmux new-window` processes which the cleanup lifecycle cannot own.
 */
export class TmuxWindowHarness implements HarnessPlugin<z.infer<typeof configSchema>> {
  readonly kind = "harness" as const;
  readonly use = TMUX_WINDOW_HARNESS_ID;
  readonly configSchema = configSchema;
  readonly presentation = {
    name: "tmux shell window",
    description: "Open an owned shell window in a Relay workspace.",
    category: "Workers",
    icon: "panel-top",
    color: "#7c3aed",
  };

  constructor(private readonly executor: AgentExecutionAdapter) {}

  async launch(request: HarnessLaunchRequest<z.infer<typeof configSchema>>): Promise<WorkerHandle> {
    const shell = process.env.SHELL || "sh";
    const execution = await this.executor.execute({
      command: shell,
      args: ["-l"],
      cwd: request.workspace.path,
      env: {},
      workerName: request.item.id,
      workerId: request.workerId,
      issue: request.item.id,
    });
    return {
      id: execution.workerId ?? request.workerId,
      startedAt: new Date().toISOString(),
      metadata: {
        persistent: true,
        workspace: request.workspace.path,
        tmux: execution.tmux,
        tmuxWindow: { shell, session: execution.tmux?.session, target: execution.tmux?.target },
      },
    };
  }

  wait(worker: WorkerHandle): Promise<WorkerCompletion | undefined> { return this.executor.wait?.(worker) ?? Promise.resolve(undefined); }
  reconcile(worker: WorkerHandle): Promise<WorkerCompletion | undefined> { return this.executor.reconcile?.(worker) ?? Promise.resolve(undefined); }
  async stop(worker: WorkerHandle): Promise<void> {
    if (!this.executor.stop) throw new Error("The tmux window harness cannot stop workers with this execution adapter.");
    await this.executor.stop(worker);
  }
}
