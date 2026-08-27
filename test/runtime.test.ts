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

describe("TmuxExecutionAdapter worker runtime", () => {
  it("tags workers and safely rebinds a stale window target before control operations", async (context) => {
    const session = `task-relay-rebind-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), "task-relay-rebind-"));
    const adapter = new TmuxExecutionAdapter({ session });
    try {
      const probe = await execa("tmux", ["has-session", "-t", session], { reject: false });
      if (probe.stderr.includes("Operation not permitted")) return context.skip();

      const execution = await adapter.execute({
        command: "sh", args: ["-c", "sleep 5"], cwd: directory, env: {},
        workerName: "ENG-777 durable identity", workerId: "wrk_runtime_rebind", issue: "ENG-777",
      });
      expect(execution.tmux?.workerId).toBe("wrk_runtime_rebind");
      await expect(execa("tmux", ["show-window-options", "-v", "-t", execution.tmux!.target!, "@task_relay_worker_id"])).resolves.toMatchObject({ stdout: "wrk_runtime_rebind" });
      await expect(execa("tmux", ["show-window-options", "-v", "-t", execution.tmux!.target!, "@task_relay_issue"])).resolves.toMatchObject({ stdout: "ENG-777" });

      // @window ids are transient across tmux server restarts. The generation tag is
      // authoritative, so a stale id is rebound before Relay opens or stops.
      const worker: WorkerHandle = {
        id: "wrk_runtime_rebind",
        startedAt: "now",
        metadata: { workspace: directory, tmux: { ...execution.tmux, target: "@999999" } },
      };
      expect(await adapter.exists(worker)).toBe(true);
      expect((worker.metadata?.tmux as { target?: string }).target).toBe(execution.tmux?.target);

      // A legacy/recreated window may have no tag yet. Exact issue/name plus
      // workspace CWD can recover it once, after which Relay upgrades it with
      // the durable tag for every later operation.
      await execa("tmux", ["set-window-option", "-u", "-t", execution.tmux!.target!, "@task_relay_worker_id"]);
      (worker.metadata?.tmux as { target?: string }).target = "@999999";
      expect(await adapter.exists(worker)).toBe(true);
      await expect(execa("tmux", ["show-window-options", "-v", "-t", execution.tmux!.target!, "@task_relay_worker_id"])).resolves.toMatchObject({ stdout: "wrk_runtime_rebind" });

      const child = await adapter.open(worker, { command: "sh", args: ["-c", "sleep 5"], open: "pane" });
      await adapter.closeChild(worker, child);

      (worker.metadata?.tmux as { target?: string }).target = "@999999";
      await adapter.stop(worker);
      expect(await adapter.exists(worker)).toBe(false);
    } finally {
      await execa("tmux", ["kill-session", "-t", session], { reject: false });
    }
  });

  it("opens, reads, and closes a pane beside a running worker", async (context) => {
    const session = `task-relay-pane-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), "task-relay-pane-"));
    const adapter = new TmuxExecutionAdapter({ session });
    try {
      const probe = await execa("tmux", ["has-session", "-t", session], { reject: false });
      if (probe.stderr.includes("Operation not permitted")) return context.skip();

      const execution = await adapter.execute({
        command: "sh",
        args: ["-c", "sleep 5"],
        cwd: directory,
        env: {},
        workerName: "ENG-500",
      });
      const worker: WorkerHandle = {
        id: "pane-worker",
        startedAt: "now",
        metadata: { tmux: execution.tmux, workspace: directory },
      };
      expect(adapter.capabilities).toEqual({ children: true, input: true, capture: true });

      const child = await adapter.open(worker, { command: "sh", args: ["-c", "echo relay-pane-marker; sleep 5"], open: "pane", name: "dev" });
      expect(child.kind).toBe("pane");
      expect(child.target).toMatch(/^%\d+$/);
      expect(await adapter.exists(worker, child.target)).toBe(true);

      // The pane runs its own shell, so allow it a moment to print.
      let output = "";
      for (let attempt = 0; attempt < 40 && !output.includes("relay-pane-marker"); attempt += 1) {
        await delay(25);
        output = await adapter.capture(worker, { child: child.target });
      }
      expect(output).toContain("relay-pane-marker");

      // The pane belongs to the worker's own window, so the worker survives it.
      await adapter.closeChild(worker, child);
      expect(await adapter.exists(worker, child.target)).toBe(false);
      expect(await adapter.exists(worker)).toBe(true);
    } finally {
      await execa("tmux", ["kill-session", "-t", session], { reject: false });
    }
  });

  it("opens a separate window and refuses to control a worker it never started", async (context) => {
    const session = `task-relay-window-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), "task-relay-window-"));
    const adapter = new TmuxExecutionAdapter({ session });
    try {
      const probe = await execa("tmux", ["has-session", "-t", session], { reject: false });
      if (probe.stderr.includes("Operation not permitted")) return context.skip();

      const execution = await adapter.execute({ command: "sh", args: ["-c", "sleep 5"], cwd: directory, env: {}, workerName: "ENG-501" });
      const worker: WorkerHandle = { id: "window-worker", startedAt: "now", metadata: { tmux: execution.tmux, workspace: directory } };

      const child = await adapter.open(worker, { command: "sh", args: ["-c", "sleep 5"], open: "window", name: "review" });
      expect(child.kind).toBe("window");
      expect(child.target).toMatch(/^@\d+$/);
      expect(child.target).not.toBe(execution.tmux?.target);
      await adapter.closeChild(worker, child);
      expect(await adapter.exists(worker, child.target)).toBe(false);

      const foreign: WorkerHandle = { id: "not-a-tmux-worker", startedAt: "now", metadata: { pid: 1 } };
      await expect(adapter.open(foreign, { command: "sh", open: "pane" })).rejects.toThrow(/no tmux target/);
    } finally {
      await execa("tmux", ["kill-session", "-t", session], { reject: false });
    }
  });
});

describe("DirectProcessAdapter worker runtime", () => {
  it("reports no live-worker capabilities and names the fix", async () => {
    const adapter = new DirectProcessAdapter();
    const worker: WorkerHandle = { id: "direct", startedAt: "now", metadata: { pid: process.pid } };
    expect(adapter.capabilities).toEqual({ children: false, input: false, capture: false });
    expect(await adapter.exists(worker)).toBe(true);
    await expect(adapter.open(worker, { command: "npm", open: "pane" })).rejects.toThrow(/execution\.adapter: tmux/);
    await expect(adapter.sendInput()).rejects.toThrow(/execution\.adapter: tmux/);
    await expect(adapter.capture()).rejects.toThrow(/execution\.adapter: tmux/);
  });
});
