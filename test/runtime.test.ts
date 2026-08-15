import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      args: ["-c", "sleep 0.5"],
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

  it("pastes and submits the initial prompt to a live terminal", async (context) => {
    const session = `task-relay-interactive-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), "task-relay-interactive-"));
    const output = join(directory, "prompt.txt");
    const adapter = new TmuxExecutionAdapter({ session, interactivePromptDelayMs: 25 });
    try {
      const probe = await execa("tmux", ["has-session", "-t", session], { reject: false });
      if (probe.stderr.includes("Operation not permitted")) return context.skip();
      const terminalProgram = [
        "const fs = require(\"node:fs\");",
        "process.stdout.write(\"\\u001b[?2004h\");",
        "process.stdin.setRawMode(true); process.stdin.resume();",
        "let value = \"\";",
        "process.stdin.on(\"data\", (chunk) => {",
        "  value += chunk.toString();",
        "  if (!/[\\r\\n]$/.test(value)) return;",
        "  const prompt = value.replace(/\\u001b\\[200~/g, \"\").replace(/\\u001b\\[201~/g, \"\").slice(0, -1).replace(/\\r/g, \"\\n\");",
        "  fs.writeFileSync(process.argv[1], prompt); process.exit(0);",
        "});",
      ].join("\n");
      const execution = await adapter.execute({
        command: process.execPath,
        args: ["-e", terminalProgram, output],
        cwd: process.cwd(),
        env: {},
        interactiveInput: "Implement ENG-124\n\nPreserve this multiline prompt.",
        workerName: "ENG-124",
      });
      const worker: WorkerHandle = { id: "interactive-worker", startedAt: "now", metadata: { tmux: execution.tmux, interactive: true } };

      const completion = await adapter.wait(worker);
      if (completion?.status === "failed") {
        const pane = await execa("tmux", ["capture-pane", "-p", "-S", "-", "-t", execution.tmux!.target!], { reject: false });
        throw new Error(`${completion.error}\n${pane.stdout}\n${pane.stderr}`);
      }
      expect(completion).toEqual({ status: "succeeded" });
      await expect(readFile(output, "utf8")).resolves.toBe("Implement ENG-124\n\nPreserve this multiline prompt.");
    } finally {
      await execa("tmux", ["kill-session", "-t", session], { reject: false });
    }
  });
});
