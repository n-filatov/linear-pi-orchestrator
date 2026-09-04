import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, type CodexAppServerProcess } from "../src/codex/app-server-client.js";
import { CodexAppServerHarness } from "../src/codex/app-server-harness.js";

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Array<Record<string, unknown>> = [];
  private turnStarts = 0;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        this.messages.push(message);
        if (typeof message.id !== "number" || typeof message.method !== "string") continue;
        if (message.method === "thread/start") this.reply(message.id, { thread: { id: "thread-1" } });
        else if (message.method === "thread/resume") this.reply(message.id, { thread: { id: "thread-1", turns: [{ id: "turn-1", status: "completed" }] } });
        else if (message.method === "turn/start") this.reply(message.id, { turn: { id: `turn-${++this.turnStarts}`, status: "inProgress" } });
        else if (message.method === "turn/steer") this.reply(message.id, { turnId: "turn-1" });
        else if (message.method === "turn/interrupt") this.reply(message.id, {});
      }
    });
    this.stdin.on("end", () => this.emit("exit", 0, null));
  }

  kill(): boolean { this.emit("exit", 0, null); return true; }
  notify(method: string, params: unknown): void { this.stdout.write(`${JSON.stringify({ method, params })}\n`); }
  private reply(id: number, result: unknown): void { this.stdout.write(`${JSON.stringify({ id, result })}\n`); }
}

afterEach(() => vi.restoreAllMocks());

describe("CodexAppServerHarness", () => {
  it("starts a safe stdio thread, steers immediately, waits when idle, and stops the owned server", async () => {
    const process = new FakeAppServer() as FakeAppServer & CodexAppServerProcess;
    const client = new CodexAppServerClient(process);
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(client);
    const harness = new CodexAppServerHarness();
    const worker = await harness.launch({
      workerId: "worker-1",
      repository: { id: "repo", root: "/repo" },
      item: { sourceId: "linear", id: "REL-1", title: "Relay" },
      workspace: { path: "/repo/work" },
      prompt: "Implement it",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      config: { args: [] },
    });

    expect(worker.metadata?.codexAppServer).toMatchObject({ threadId: "thread-1", turnId: "turn-1", transport: "stdio", effort: "high" });
    expect(process.messages).toContainEqual(expect.objectContaining({ method: "thread/start", params: expect.objectContaining({ approvalPolicy: "never", sandbox: "workspace-write" }) }));

    await expect(harness.sendPrompt(worker, { prompt: "Do it now", delivery: "immediate", timeoutMs: 1_000 }))
      .resolves.toMatchObject({ threadId: "thread-1", turnId: "turn-1", delivery: "immediate" });
    expect(process.messages).toContainEqual(expect.objectContaining({ method: "turn/steer", params: expect.objectContaining({ expectedTurnId: "turn-1" }) }));

    const idle = harness.sendPrompt(worker, { prompt: "Then test", delivery: "idle", timeoutMs: 1_000 });
    process.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    await expect(idle).resolves.toMatchObject({ threadId: "thread-1", turnId: "turn-2", delivery: "idle" });

    await harness.stop(worker);
    expect(process.messages).toContainEqual(expect.objectContaining({ method: "turn/interrupt" }));
  });

  it("uses a loopback App Server and persists the tmux binding for a visible remote TUI", async () => {
    const process = new FakeAppServer() as FakeAppServer & CodexAppServerProcess;
    const client = new CodexAppServerClient(process);
    const remote = vi.spyOn(CodexAppServerClient, "startRemote").mockResolvedValue({ client, endpoint: "ws://127.0.0.1:43123" });
    const harness = new CodexAppServerHarness();

    const worker = await harness.launch({
      workerId: "worker-tmux-codex",
      repository: { id: "repo", root: "/repo" },
      item: { sourceId: "linear", id: "REL-3", title: "Terminal Codex" },
      workspace: { path: "/repo/work" },
      prompt: "Implement it",
      config: { args: [] },
      harnessInput: { remoteTui: { action: "tmux-window", workerId: "tmux-worker", session: "relay", target: "@9" } },
    });

    expect(remote).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/work" }));
    expect(worker.metadata?.codexAppServer).toMatchObject({
      transport: "websocket", endpoint: "ws://127.0.0.1:43123", threadId: "thread-1",
      tmux: { action: "tmux-window", workerId: "tmux-worker", session: "relay", target: "@9" },
    });
    await harness.closeAll();
  });

  it("resumes a persisted App Server thread before sending another prompt", async () => {
    const process = new FakeAppServer() as FakeAppServer & CodexAppServerProcess;
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(new CodexAppServerClient(process));
    const harness = new CodexAppServerHarness();
    const worker = {
      id: "worker-after-restart",
      startedAt: "2026-08-28T12:00:00.000Z",
      metadata: {
        codexAppServer: {
          transport: "stdio",
          threadId: "thread-1",
          turnId: "turn-1",
          workspace: "/repo/work",
          model: "gpt-5.6-terra",
        },
      },
    } as const;

    await expect(harness.sendPrompt(worker, { prompt: "Continue after restart", delivery: "idle", timeoutMs: 1_000 }))
      .resolves.toMatchObject({ threadId: "thread-1", turnId: "turn-1", delivery: "idle" });
    expect(process.messages).toContainEqual(expect.objectContaining({
      method: "thread/resume",
      params: expect.objectContaining({ threadId: "thread-1", cwd: "/repo/work", model: "gpt-5.6-terra" }),
    }));
    expect(process.messages).toContainEqual(expect.objectContaining({ method: "turn/start" }));
    await harness.closeAll();
  });

  it("can keep a send-prompt action open until the resulting turn completes", async () => {
    const process = new FakeAppServer() as FakeAppServer & CodexAppServerProcess;
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(new CodexAppServerClient(process));
    const harness = new CodexAppServerHarness();
    const worker = await harness.launch({
      workerId: "worker-wait",
      repository: { id: "repo", root: "/repo" },
      item: { sourceId: "linear", id: "REL-2", title: "Wait" },
      workspace: { path: "/repo/work" },
      prompt: "Start",
      config: { args: [] },
    });

    const sent = harness.sendPrompt(worker, {
      prompt: "Finish this turn",
      delivery: "immediate",
      waitForCompletion: true,
      timeoutMs: 1_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    process.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    await expect(sent).resolves.toMatchObject({ turnId: "turn-1", turnStatus: "completed" });
    await harness.closeAll();
  });
});
