import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient, type CodexAppServerProcess, type CodexAppServerWebSocket } from "../src/codex/app-server-client.js";

class FakeAppServerProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public killed = false;
  public readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  public readonly requests: Array<Record<string, unknown>> = [];

  public constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        if (line) this.requests.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  public kill(signal?: NodeJS.Signals | number): boolean { this.killed = true; this.killSignals.push(signal); return true; }
  public reply(id: number, result: unknown): void { this.stdout.write(`${JSON.stringify({ id, result })}\n`); }
  public notify(method: string, params: unknown): void { this.stdout.write(`${JSON.stringify({ method, params })}\n`); }
  public serverRequest(id: number | string, method: string, params: unknown): void { this.stdout.write(`${JSON.stringify({ id, method, params })}\n`); }
  public exit(): void { this.emit("exit", 0, null); }
}

class FakeWebSocket implements CodexAppServerWebSocket {
  readonly readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener);
    this.listeners.set(type, entries);
  }
  removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void { this.listeners.get(type)?.delete(listener); }
  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data) as { id?: number; method?: string };
    if (message.method === "initialize" && message.id) queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: message.id, result: { userAgent: "codex", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } }) }));
  }
  close(): void { this.emit("close", { code: 1000 }); }
  emit(type: "open" | "message" | "error" | "close", event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

function fakeProcess(): FakeAppServerProcess & CodexAppServerProcess {
  return new FakeAppServerProcess() as FakeAppServerProcess & CodexAppServerProcess;
}

async function nextMicrotask(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("CodexAppServerClient", () => {
  it("spawns codex app-server and completes initialize before initialized", async () => {
    const process = fakeProcess();
    const start = CodexAppServerClient.start({
      initialize: { clientInfo: { name: "relay", version: "1.0.0" } },
      spawn(command, args) {
        expect(command).toBe("codex");
        expect(args).toEqual(["app-server", "--stdio"]);
        queueMicrotask(() => process.reply(1, { userAgent: "codex", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" }));
        return process;
      },
    });

    await start;
    expect(process.requests).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "relay", version: "1.0.0", title: null },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      },
      { method: "initialized" },
    ]);
    process.exit();
  });

  it("starts a Relay-owned loopback WebSocket App Server for a remote Codex TUI", async () => {
    const process = fakeProcess();
    const socket = new FakeWebSocket();
    const started = CodexAppServerClient.startRemote({
      endpoint: "ws://127.0.0.1:43123",
      initialize: { clientInfo: { name: "relay", version: "1.0.0" } },
      spawn(command, args) {
        expect(command).toBe("codex");
        expect(args).toEqual(["app-server", "--listen", "ws://127.0.0.1:43123"]);
        return process;
      },
      connect(endpoint) {
        expect(endpoint).toBe("ws://127.0.0.1:43123");
        queueMicrotask(() => socket.emit("open", {}));
        return socket;
      },
    });
    const { client, endpoint } = await started;
    expect(endpoint).toBe("ws://127.0.0.1:43123");
    expect(socket.sent.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ method: "initialize" }),
      { method: "initialized" },
    ]);
    await client.stop({ forceKillTimeoutMs: 0 });
    expect(process.killed).toBe(true);
  });

  it("retries the WebSocket connection while the App Server listener is binding", async () => {
    const process = fakeProcess();
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    let attempts = 0;
    const started = CodexAppServerClient.startRemote({
      endpoint: "ws://127.0.0.1:43124",
      initialize: { clientInfo: { name: "relay", version: "1.0.0" } },
      spawn: () => process,
      connect() {
        attempts += 1;
        const socket = attempts === 1 ? first : second;
        queueMicrotask(() => socket.emit(attempts === 1 ? "error" : "open", {}));
        return socket;
      },
      connectTimeoutMs: 1_000,
    });
    const { client } = await started;
    expect(attempts).toBe(2);
    await client.stop({ forceKillTimeoutMs: 0 });
  });

  it("correlates requests and records lifecycle exclusively from turn notifications", async () => {
    const process = fakeProcess();
    const client = new CodexAppServerClient(process);
    const notifications: string[] = [];
    client.onNotification((notification) => notifications.push(notification.method));

    const thread = client.startThread({ cwd: "/repo" });
    process.reply(1, { thread: { id: "thread-1" } });
    await expect(thread).resolves.toEqual({ thread: { id: "thread-1" } });
    expect(client.lifecycle("thread-1")).toEqual({ threadId: "thread-1", status: "idle" });

    const turn = client.requestTurn({ threadId: "thread-1", input: [{ type: "text", text: "Implement it" }] });
    process.reply(2, { turn: { id: "turn-1", status: "inProgress" } });
    await turn;
    expect(client.lifecycle("thread-1")?.status).toBe("idle");
    expect(process.requests[1]).toMatchObject({ method: "turn/start", params: { input: [{ type: "text", text: "Implement it", text_elements: [] }] } });

    process.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } });
    expect(client.lifecycle("thread-1")).toMatchObject({ status: "inProgress", activeTurnId: "turn-1" });
    process.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    expect(client.lifecycle("thread-1")).toMatchObject({ status: "completed", lastTurn: { id: "turn-1", status: "completed" } });
    expect(notifications).toEqual(["turn/started", "turn/completed"]);
    process.exit();
  });

  it("supports resume, model listing, steer, interrupt, server errors, and graceful stop", async () => {
    const process = fakeProcess();
    const client = new CodexAppServerClient(process);
    const errors: string[] = [];
    client.onError((error) => errors.push(error.message));

    const resume = client.resumeThread({ threadId: "thread-1" });
    process.reply(1, { thread: { id: "thread-1" } });
    await resume;
    const models = client.listModels({ includeHidden: false, limit: 100 });
    process.reply(2, { data: [{ id: "codex", model: "gpt-codex", displayName: "Codex", hidden: false, supportedReasoningEfforts: [] }] });
    await expect(models).resolves.toMatchObject({ data: [{ model: "gpt-codex" }] });
    const steer = client.steerTurn({ threadId: "thread-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "Focus" }] });
    process.reply(3, { turnId: "turn-1" });
    await expect(steer).resolves.toEqual({ turnId: "turn-1" });
    const interrupt = client.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });
    process.reply(4, {});
    await interrupt;

    const pending = client.request("thread/list");
    process.emit("error", new Error("spawn failed"));
    await expect(pending).rejects.toThrow("spawn failed");
    expect(errors).toEqual(["spawn failed"]);

    const stopping = client.stop();
    await nextMicrotask();
    expect(process.stdin.writableEnded).toBe(true);
    process.exit();
    await stopping;
    expect(process.killed).toBe(false);
  });

  it("waits for the matching turn/completed notification and handles completion races", async () => {
    const process = fakeProcess();
    const client = new CodexAppServerClient(process);
    const request = client.requestTurn({ threadId: "thread-1", input: [{ type: "text", text: "Implement it" }] });
    process.reply(1, { turn: { id: "turn-1", status: "completed" } });
    await request;

    let settled = false;
    const waiting = client.waitForTurn("thread-1", "turn-1", { timeoutMs: 100 });
    void waiting.then(() => { settled = true; });
    await nextMicrotask();
    expect(settled).toBe(false);
    process.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    await expect(waiting).resolves.toMatchObject({ id: "turn-1", status: "completed" });

    // A caller that attaches after the notification still gets the recorded
    // terminal turn rather than waiting forever.
    await expect(client.waitForTurn("thread-1", "turn-1")).resolves.toMatchObject({ id: "turn-1" });
    process.exit();
  });

  it("surfaces server requests separately from correlated responses", async () => {
    const process = fakeProcess();
    const client = new CodexAppServerClient(process);
    const serverRequests: Array<{ id: number | string; method: string }> = [];
    client.onServerRequest((request) => {
      serverRequests.push({ id: request.id, method: request.method });
      client.respond(request.id, { decision: "approved" });
    });

    const pending = client.request("thread/list");
    process.serverRequest(1, "item/commandExecution/requestApproval", { threadId: "thread-1" });
    await nextMicrotask();
    expect(serverRequests).toEqual([{ id: 1, method: "item/commandExecution/requestApproval" }]);
    expect(process.requests[1]).toMatchObject({ id: 1, result: { decision: "approved" } });
    process.reply(1, []);
    await expect(pending).resolves.toEqual([]);
    process.exit();
  });

  it("does not treat stderr warnings as process failures", async () => {
    const process = fakeProcess();
    const client = new CodexAppServerClient(process);
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    process.stderr.write("warning: optional config is unavailable\n");
    const pending = client.request("thread/list");
    process.reply(1, []);
    await expect(pending).resolves.toEqual([]);
    expect(errors).toEqual([]);
    process.exit();
  });

  it("force-kills a process that does not exit after stdin closes", async () => {
    const process = fakeProcess();
    const client = new CodexAppServerClient(process);
    await client.stop({ timeoutMs: 1, forceKillTimeoutMs: 1 });
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("rejects pending requests and turn waits when the process exits", async () => {
    const process = fakeProcess();
    const client = new CodexAppServerClient(process);
    const request = client.request("thread/list");
    const wait = client.waitForTurn("thread-1", "turn-1", { timeoutMs: 100 });
    process.exit();
    await expect(request).rejects.toThrow(/exited before replying/i);
    await expect(wait).rejects.toThrow(/exited before replying/i);
    await expect(client.request("thread/list")).rejects.toThrow(/closed/i);
  });
});
