import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { DirectProcessAdapter, TmuxExecutionAdapter } from "../src/runtime/execution-adapters.js";
import type { AgentExecution, AgentExecutionResult } from "../src/agents/types.js";
import type { WorkerHandle } from "../src/domain/index.js";

describe("DirectProcessAdapter", () => {
  it("does not resolve stop until the worker process has exited", async () => {
    const adapter = new DirectProcessAdapter({ stopTimeoutMs: 500 });
    const execution = await adapter.execute({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: {},
      workerName: "stop-test",
    });
    expect(execution.pid).toBeTruthy();
    const worker: WorkerHandle = { id: "direct-worker", startedAt: "now", metadata: { pid: execution.pid } };
    try {
      await delay(25);
      await adapter.stop(worker);
      expect(await adapter.reconcile(worker)).toMatchObject({ status: "failed" });
    } finally {
      if (execution.pid) {
        try { process.kill(execution.pid, "SIGKILL"); } catch { /* already stopped */ }
      }
    }
  });
});

describe("TmuxExecutionAdapter", () => {
  it("lets tmux allocate distinct windows for concurrent launches", async (context) => {
    const session = `task-relay-test-${randomUUID()}`;
    const adapter = new TmuxExecutionAdapter({ session });
    const execution = (workerName: string): AgentExecution => ({
      command: "sh",
      args: ["-c", "sleep 0.05"],
      cwd: process.cwd(),
      env: {},
      workerName,
    });
    try {
      // Some sandboxed CI environments expose the binary but prohibit access
      // to its Unix socket. Keep the integration test meaningful where tmux is
      // usable without making that host policy a product failure.
      const probe = await execa("tmux", ["has-session", "-t", session], { reject: false });
      if (probe.stderr.includes("Operation not permitted")) return context.skip();
      const [left, right] = await Promise.all([
        adapter.execute(execution("same-name")),
        adapter.execute(execution("same-name")),
      ]);
      expect(left.tmux?.target).toBeTruthy();
      expect(right.tmux?.target).toBeTruthy();
      expect(left.tmux?.target).not.toBe(right.tmux?.target);
      expect(left.tmux?.index).not.toBe(right.tmux?.index);

      const handle = (result: AgentExecutionResult): WorkerHandle => ({
        id: "worker",
        startedAt: "now",
        metadata: { tmux: result.tmux },
      });
      await expect(Promise.all([adapter.wait(handle(left)), adapter.wait(handle(right))]))
        .resolves.toEqual([{ status: "succeeded" }, { status: "succeeded" }]);
    } finally {
      await execa("tmux", ["kill-session", "-t", session], { reject: false });
    }
  });
});
