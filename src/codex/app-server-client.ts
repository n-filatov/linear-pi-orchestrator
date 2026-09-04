import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { StringDecoder } from "node:string_decoder";

export type CodexJsonValue = null | boolean | number | string | CodexJsonValue[] | { [key: string]: CodexJsonValue };

export type CodexAppServerClientInfo = {
  name: string;
  version: string;
  title?: string | null;
};

export type CodexAppServerInitializeOptions = {
  clientInfo: CodexAppServerClientInfo;
  capabilities?: {
    experimentalApi?: boolean;
    requestAttestation?: boolean;
    optOutNotificationMethods?: string[] | null;
    extensions?: Record<string, CodexJsonValue> | null;
  } | null;
};

export type CodexAppServerInitializeResult = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
};

export type CodexThread = {
  id: string;
  /** Populated by thread/resume and thread/read in the App Server protocol. */
  turns?: CodexTurn[];
  [key: string]: unknown;
};

export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type CodexTurn = {
  id: string;
  status: CodexTurnStatus;
  [key: string]: unknown;
};

export type CodexThreadStartParams = {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: CodexJsonValue | null;
  approvalsReviewer?: CodexJsonValue | null;
  sandbox?: CodexJsonValue | null;
  config?: Record<string, CodexJsonValue> | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: CodexJsonValue | null;
  ephemeral?: boolean | null;
  sessionStartSource?: "startup" | "clear" | null;
  threadSource?: CodexJsonValue | null;
};

export type CodexThreadResumeParams = Omit<CodexThreadStartParams, "serviceName" | "ephemeral" | "sessionStartSource" | "threadSource"> & {
  threadId: string;
};

export type CodexThreadResult = {
  thread: CodexThread;
  [key: string]: unknown;
};

export type CodexUserInput =
  | { type: "text"; text: string; text_elements?: CodexJsonValue[] }
  | { type: "image"; url: string; detail?: CodexJsonValue }
  | { type: "localImage"; path: string; detail?: CodexJsonValue }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill" | "mention"; name: string; path: string };

export type CodexTurnStartParams = {
  threadId: string;
  input: CodexUserInput[];
  clientUserMessageId?: string | null;
  cwd?: string | null;
  approvalPolicy?: CodexJsonValue | null;
  approvalsReviewer?: CodexJsonValue | null;
  sandboxPolicy?: CodexJsonValue | null;
  model?: string | null;
  serviceTier?: string | null;
  effort?: CodexJsonValue | null;
  summary?: CodexJsonValue | null;
  personality?: CodexJsonValue | null;
  outputSchema?: CodexJsonValue | null;
};

export type CodexTurnSteerParams = {
  threadId: string;
  expectedTurnId: string;
  input: CodexUserInput[];
  clientUserMessageId?: string | null;
};

export type CodexTurnInterruptParams = { threadId: string; turnId: string };

export type CodexTurnStartResult = { turn: CodexTurn };
export type CodexTurnSteerResult = { turnId: string };

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  defaultReasoningEffort?: string;
  [key: string]: unknown;
};

export type CodexModelListResult = {
  data: CodexModel[];
  nextCursor?: string | null;
};

export type CodexAppServerNotification = {
  method: string;
  params?: CodexJsonValue;
};

export type CodexAppServerRequestId = number | string;

/** A request initiated by the app-server (for example an approval request). */
export type CodexAppServerServerRequest = {
  id: CodexAppServerRequestId;
  method: string;
  params?: CodexJsonValue;
};

export type CodexAppServerStopOptions = {
  /** How long to wait for stdin shutdown before sending SIGTERM. */
  timeoutMs?: number;
  /** How long to wait after SIGTERM before sending SIGKILL. */
  forceKillTimeoutMs?: number;
};

export type CodexAppServerWaitForTurnOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CodexThreadLifecycle = {
  threadId: string;
  status: "idle" | "inProgress" | "completed" | "interrupted" | "failed";
  activeTurnId?: string;
  lastTurn?: CodexTurn;
};

export type CodexAppServerProcess = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "kill" | "on" | "once">;

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => CodexAppServerProcess;

export type CodexAppServerStartOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: CodexAppServerSpawn;
  initialize: CodexAppServerInitializeOptions;
};

type WebSocketMessageEvent = { data: string | ArrayBuffer | ArrayBufferView };
type WebSocketCloseEvent = { code?: number; reason?: string };
export type CodexAppServerWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event | WebSocketMessageEvent | WebSocketCloseEvent) => void, options?: { once?: boolean }): void;
  removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event | WebSocketMessageEvent | WebSocketCloseEvent) => void): void;
};

export type CodexAppServerRemoteStartOptions = Omit<CodexAppServerStartOptions, "args"> & {
  /** A loopback-only endpoint makes the App Server available to a local Codex TUI. */
  endpoint?: string;
  /** Additional arguments passed after `codex app-server` and before `--listen`. */
  args?: string[];
  /** Test seam for the native WebSocket constructor. */
  connect?: (endpoint: string) => CodexAppServerWebSocket;
  connectTimeoutMs?: number;
};

export class CodexAppServerError extends Error {
  public constructor(message: string, public readonly code?: number, public readonly data?: CodexJsonValue) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

type PendingRequest = {
  resolve(value: CodexJsonValue): void;
  reject(error: Error): void;
};

type RequestEnvelope = { id: CodexAppServerRequestId; method: string; params?: CodexJsonValue };
type ResponseEnvelope = { id: CodexAppServerRequestId; result?: CodexJsonValue; error?: { message?: string; code?: number; data?: CodexJsonValue } };
type TurnWaiter = {
  threadId: string;
  turnId: string;
  resolve(turn: CodexTurn): void;
  reject(error: Error): void;
  cleanup(): void;
};

/**
 * Small JSONL client for the Codex App Server stdio protocol.
 *
 * It intentionally owns only the methods Relay needs today. Unknown server
 * notifications are still forwarded, so callers can adopt future protocol
 * additions without replacing the transport layer.
 */
export class CodexAppServerClient {
  private readonly pending = new Map<CodexAppServerRequestId, PendingRequest>();
  private readonly notifications = new EventEmitter();
  private readonly errors = new EventEmitter();
  private readonly serverRequests = new EventEmitter();
  private readonly lifecycles = new Map<string, CodexThreadLifecycle>();
  private readonly turnWaiters = new Set<TurnWaiter>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private closed = false;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private resolveExit!: () => void;
  private exitPromise: Promise<void>;

  private readonly process: CodexAppServerProcess;
  private readonly socket?: CodexAppServerWebSocket;

  public constructor(process: CodexAppServerProcess, socket?: CodexAppServerWebSocket) {
    this.process = process;
    this.socket = socket;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    process.once("exit", (code: number | null, signal: NodeJS.Signals | null) => this.onProcessExit(code, signal));
    if (socket) {
      socket.addEventListener("message", (event) => {
        const data = (event as WebSocketMessageEvent).data;
        // A WebSocket frame is a complete JSON-RPC message, unlike stdio where
        // newlines frame JSONL. Normalize each frame to the parser's JSONL form.
        if (typeof data === "string") this.read(`${data}\n`);
        else if (ArrayBuffer.isView(data)) this.read(Buffer.concat([Buffer.from(data.buffer, data.byteOffset, data.byteLength), Buffer.from("\n")]));
        else if (data instanceof ArrayBuffer) this.read(Buffer.concat([Buffer.from(data), Buffer.from("\n")]));
      });
      socket.addEventListener("error", () => this.onProcessError(new CodexAppServerError("Codex App Server WebSocket connection failed.")));
      socket.addEventListener("close", (event) => {
        if (this.stopping) return;
        const close = event as WebSocketCloseEvent;
        this.close(new CodexAppServerError(`Codex App Server WebSocket closed${close.code === undefined ? "" : ` (${close.code})`}.`), false);
      });
    } else {
      process.stdout.on("data", (chunk: Buffer | string) => this.read(chunk));
    }
    // stderr is diagnostic output, not a protocol failure. Codex can emit
    // warnings while continuing to serve requests successfully.
    process.stderr.on("data", () => undefined);
    process.stdout.on("error", (error: Error) => this.onProcessError(error));
    process.stdin.on("error", (error: Error) => this.onProcessError(error));
    process.stderr.on("error", (error: Error) => this.onProcessError(error));
    process.on("error", (error: Error) => this.onProcessError(error));
  }

  public static async start(options: CodexAppServerStartOptions): Promise<CodexAppServerClient> {
    const spawn = options.spawn ?? defaultSpawn;
    // App Server defaults to its supported JSONL stdio transport. Do not opt
    // into the experimental WebSocket listener for Relay workers.
    const process = spawn(options.command ?? "codex", options.args ?? ["app-server", "--stdio"], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    });
    const client = new CodexAppServerClient(process);
    try {
      await client.initialize(options.initialize);
      return client;
    } catch (error) {
      await client.stop({ timeoutMs: 100, forceKillTimeoutMs: 100 }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Starts a Relay-owned App Server on a private loopback WebSocket endpoint.
   * Relay keeps its JSON-RPC client connection while a `codex --remote` TUI may
   * attach from an owned tmux pane.
   */
  public static async startRemote(options: CodexAppServerRemoteStartOptions): Promise<{ client: CodexAppServerClient; endpoint: string }> {
    const endpoint = options.endpoint ?? await loopbackWebSocketEndpoint();
    if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) {
      throw new Error(`Codex remote endpoint must be loopback ws://127.0.0.1:<port>; received '${endpoint}'.`);
    }
    const spawn = options.spawn ?? defaultSpawn;
    const process = spawn(options.command ?? "codex", ["app-server", ...(options.args ?? []), "--listen", endpoint], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    });
    let socket: CodexAppServerWebSocket | undefined;
    try {
      socket = await connectWebSocket(endpoint, options.connect, options.connectTimeoutMs);
      const client = new CodexAppServerClient(process, socket);
      await client.initialize(options.initialize);
      return { client, endpoint };
    } catch (error) {
      try { socket?.close(); } catch { /* best effort */ }
      try { process.kill("SIGTERM"); } catch { /* best effort */ }
      throw new Error(`Could not start Relay-managed Codex App Server at ${endpoint}: ${asError(error).message}`);
    }
  }

  /** Performs the protocol-required initialize request followed by initialized notification. */
  public async initialize(options: CodexAppServerInitializeOptions): Promise<CodexAppServerInitializeResult> {
    const result = await this.request<CodexAppServerInitializeResult>("initialize", {
      clientInfo: { title: null, ...options.clientInfo },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        ...options.capabilities,
      },
    });
    this.notify("initialized");
    return result;
  }

  public async startThread(params: CodexThreadStartParams = {}): Promise<CodexThreadResult> {
    const result = await this.request<CodexThreadResult>("thread/start", params);
    this.ensureLifecycle(result.thread.id);
    return result;
  }

  public async resumeThread(params: CodexThreadResumeParams): Promise<CodexThreadResult> {
    const result = await this.request<CodexThreadResult>("thread/resume", params);
    this.ensureLifecycle(result.thread.id);
    return result;
  }

  public requestTurn(params: CodexTurnStartParams): Promise<CodexTurnStartResult> {
    return this.request<CodexTurnStartResult>("turn/start", normalizeTurnInput(params));
  }

  public steerTurn(params: CodexTurnSteerParams): Promise<CodexTurnSteerResult> {
    return this.request<CodexTurnSteerResult>("turn/steer", normalizeTurnInput(params));
  }

  public interruptTurn(params: CodexTurnInterruptParams): Promise<Record<string, never>> {
    return this.request<Record<string, never>>("turn/interrupt", params);
  }

  public listModels(params: { cursor?: string | null; limit?: number | null; includeHidden?: boolean | null } = {}): Promise<CodexModelListResult> {
    return this.request<CodexModelListResult>("model/list", params);
  }

  /** Send a raw protocol request; JSON-RPC ids are correlated with responses. */
  public request<T = CodexJsonValue>(method: string, params?: CodexJsonValue): Promise<T> {
    if (this.closed) return Promise.reject(new CodexAppServerError("Codex App Server is closed."));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  public notify(method: string, params?: CodexJsonValue): void {
    if (this.closed) throw new CodexAppServerError("Codex App Server is closed.");
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  public onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notifications.on("notification", listener);
    return () => this.notifications.off("notification", listener);
  }

  public onError(listener: (error: Error) => void): () => void {
    this.errors.on("error", listener);
    return () => this.errors.off("error", listener);
  }

  /** Receives requests initiated by the app-server, such as approval prompts. */
  public onServerRequest(listener: (request: CodexAppServerServerRequest) => void): () => void {
    this.serverRequests.on("request", listener);
    return () => this.serverRequests.off("request", listener);
  }

  /** Replies to a request initiated by the app-server. */
  public respond(requestId: CodexAppServerRequestId, result: CodexJsonValue = null): void {
    if (this.closed) throw new CodexAppServerError("Codex App Server is closed.");
    this.write({ id: requestId, result });
  }

  /** Replies with a JSON-RPC error to a request initiated by the app-server. */
  public respondError(requestId: CodexAppServerRequestId, message: string, code = -32603, data?: CodexJsonValue): void {
    if (this.closed) throw new CodexAppServerError("Codex App Server is closed.");
    this.write({ id: requestId, error: { message, code, ...(data === undefined ? {} : { data }) } });
  }

  public lifecycle(threadId: string): CodexThreadLifecycle | undefined {
    const lifecycle = this.lifecycles.get(threadId);
    return lifecycle && { ...lifecycle };
  }

  /**
   * Ends stdin and waits for the app-server process to exit. A stuck process is
   * terminated and then force-killed so shutdown cannot hang the backend.
   */
  public stop(options: CodexAppServerStopOptions | number = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const normalized = typeof options === "number" ? { timeoutMs: options } : options;
    const timeoutMs = nonNegativeTimeout(normalized.timeoutMs, 5_000);
    const forceKillTimeoutMs = nonNegativeTimeout(normalized.forceKillTimeoutMs, 100);
    this.stopPromise = (async () => {
      if (this.socket) {
        this.stopping = true;
        try { this.socket.close(1000, "Relay stopped the App Server"); } catch (error) { this.onProcessError(asError(error)); }
        this.kill("SIGTERM");
        if (await this.waitForExit(forceKillTimeoutMs)) return;
        this.kill("SIGKILL");
        this.close(new CodexAppServerError("Codex App Server was force-killed."), false);
        return;
      } else if (!this.process.stdin.destroyed && !this.process.stdin.writableEnded) {
        try { this.process.stdin.end(); } catch (error) { this.onProcessError(asError(error)); }
      }
      if (this.closed || await this.waitForExit(timeoutMs)) return;
      this.kill("SIGTERM");
      if (this.closed || await this.waitForExit(forceKillTimeoutMs)) return;
      this.kill("SIGKILL");
      // A successful kill normally causes exit, but do not leak a promise if
      // a test double or a broken child never emits the exit event.
      this.close(new CodexAppServerError("Codex App Server was force-killed."), false);
    })();
    return this.stopPromise;
  }

  /** Resolves when the matching turn/completed notification arrives. */
  public waitForTurn(threadId: string, turnId: string, options: CodexAppServerWaitForTurnOptions = {}): Promise<CodexTurn> {
    const timeoutMs = nonNegativeTimeout(options.timeoutMs, 300_000);
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (this.closed) return Promise.reject(new CodexAppServerError("Codex App Server is closed."));
    const previous = this.lifecycles.get(threadId)?.lastTurn;
    if (previous?.id === turnId && isTerminalTurnStatus(previous.status)) return Promise.resolve(previous);

    return new Promise<CodexTurn>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;
      const waiter: TurnWaiter = {
        threadId,
        turnId,
        resolve: (turn) => { waiter.cleanup(); resolve(turn); },
        reject: (error) => { waiter.cleanup(); reject(error); },
        cleanup: () => {
          this.turnWaiters.delete(waiter);
          if (timer) clearTimeout(timer);
          if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);
        },
      };
      this.turnWaiters.add(waiter);
      abortListener = () => waiter.reject(abortError());
      options.signal?.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(() => waiter.reject(new CodexAppServerError(`Timed out waiting for turn ${turnId} in thread ${threadId}.`)), timeoutMs);
    });
  }

  private write(message: Omit<RequestEnvelope, "id"> | RequestEnvelope | { id: CodexAppServerRequestId; result: CodexJsonValue } | { id: CodexAppServerRequestId; error: { message: string; code?: number; data?: CodexJsonValue } }): void {
    const line = `${JSON.stringify(message)}\n`;
    try {
      if (this.socket) this.socket.send(line);
      else this.process.stdin.write(line);
    } catch (error) {
      const normalized = asError(error);
      this.onProcessError(normalized);
      throw normalized;
    }
  }

  private read(chunk: Buffer | string): void {
    this.stdoutBuffer += this.stdoutDecoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line) as unknown);
      } catch (error) {
        this.onProcessError(new CodexAppServerError(`Invalid App Server JSONL message: ${asError(error).message}`));
      }
    }
  }

  private handle(value: unknown): void {
    if (!isRecord(value) || typeof value.method === "undefined" && typeof value.id === "undefined") {
      throw new CodexAppServerError("Invalid App Server message envelope.");
    }
    if ((typeof value.id === "number" || typeof value.id === "string") && typeof value.method === "string") {
      const request: CodexAppServerServerRequest = { id: value.id, method: value.method, ...(value.params === undefined ? {} : { params: value.params as CodexJsonValue }) };
      if (this.serverRequests.listenerCount("request") === 0) {
        this.emitError(new CodexAppServerError(`Unhandled Codex App Server request: ${request.method}.`));
      } else {
        try { this.serverRequests.emit("request", request); } catch (error) { this.emitError(asError(error)); }
      }
      return;
    }
    if (typeof value.id === "number" || typeof value.id === "string") {
      if (!(Object.prototype.hasOwnProperty.call(value, "result") || Object.prototype.hasOwnProperty.call(value, "error"))) {
        throw new CodexAppServerError("Invalid App Server response envelope.");
      }
      const response = value as ResponseEnvelope;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new CodexAppServerError(response.error.message ?? "Codex App Server request failed.", response.error.code, response.error.data));
      } else {
        pending.resolve(response.result ?? null);
      }
      return;
    }
    if (typeof value.method !== "string") throw new CodexAppServerError("Invalid App Server notification.");
    const notification: CodexAppServerNotification = { method: value.method, ...(value.params === undefined ? {} : { params: value.params as CodexJsonValue }) };
    this.updateLifecycle(notification);
    this.notifications.emit("notification", notification);
  }

  private updateLifecycle(notification: CodexAppServerNotification): void {
    if ((notification.method !== "turn/started" && notification.method !== "turn/completed") || !isRecord(notification.params)) return;
    const threadId = notification.params.threadId;
    const turn = notification.params.turn;
    if (typeof threadId !== "string" || !isTurn(turn)) return;
    const lifecycle = this.ensureLifecycle(threadId);
    if (notification.method === "turn/started") {
      // A delayed started event must not move an already completed turn back
      // to inProgress.
      if (lifecycle.lastTurn?.id === turn.id && isTerminalTurnStatus(lifecycle.lastTurn.status)) return;
      lifecycle.lastTurn = turn;
      lifecycle.status = "inProgress";
      lifecycle.activeTurnId = turn.id;
    } else {
      // Ignore a stale completion from an older turn while a newer turn is
      // active. This keeps the observable state monotonic for the active turn.
      const staleCompletion = lifecycle.activeTurnId && lifecycle.activeTurnId !== turn.id;
      if (!staleCompletion) {
        lifecycle.lastTurn = turn;
        lifecycle.status = turn.status;
        if (isTerminalTurnStatus(turn.status)) delete lifecycle.activeTurnId;
        else lifecycle.activeTurnId = turn.id;
      }
      for (const waiter of this.turnWaiters) {
        if (waiter.threadId === threadId && waiter.turnId === turn.id) waiter.resolve(turn);
      }
    }
  }

  private ensureLifecycle(threadId: string): CodexThreadLifecycle {
    let lifecycle = this.lifecycles.get(threadId);
    if (!lifecycle) {
      lifecycle = { threadId, status: "idle" };
      this.lifecycles.set(threadId, lifecycle);
    }
    return lifecycle;
  }

  private onProcessError(error: Error): void {
    if (this.closed) return;
    this.emitError(error);
    this.close(error, false);
  }

  private onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    const detail = signal ? ` (signal ${signal})` : code === null ? "" : ` (code ${code})`;
    this.close(new CodexAppServerError(`Codex App Server exited before replying${detail}.`), false);
  }

  private close(error: Error, report: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (report) this.emitError(error);
    this.rejectPending(error);
    for (const waiter of [...this.turnWaiters]) waiter.reject(error);
    this.resolveExit();
  }

  private emitError(error: Error): void {
    // EventEmitter treats an "error" event specially and throws when it has
    // no listeners. Process failures must never become uncaught exceptions.
    if (this.errors.listenerCount("error") > 0) this.errors.emit("error", error);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.closed) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exitPromise.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private kill(signal: NodeJS.Signals): void {
    if (this.closed) return;
    try { this.process.kill(signal); } catch (error) { this.close(asError(error), true); }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function loopbackWebSocketEndpoint(): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a loopback port for Codex App Server.")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  return `ws://127.0.0.1:${port}`;
}

async function connectWebSocket(endpoint: string, connect: CodexAppServerRemoteStartOptions["connect"], timeoutMs = 5_000): Promise<CodexAppServerWebSocket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  // `codex app-server --listen` returns control before its WebSocket listener
  // has bound the port. A first connection can therefore fail legitimately;
  // keep retrying within the caller's bounded startup timeout.
  while (Date.now() < deadline) {
    try {
      return await openWebSocket(endpoint, connect, Math.max(1, Math.min(1_000, deadline - Date.now())));
    } catch (error) {
      lastError = asError(error);
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error(`Timed out connecting to ${endpoint}.`);
}

async function openWebSocket(endpoint: string, connect: CodexAppServerRemoteStartOptions["connect"], timeoutMs: number): Promise<CodexAppServerWebSocket> {
  const socket = (connect ?? ((url: string) => new WebSocket(url) as unknown as CodexAppServerWebSocket))(endpoint);
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error) => {
        if (timer) clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", closed);
        error ? reject(error) : resolve();
      };
      const opened = () => finish();
      const failed = () => finish(new Error("WebSocket connection failed."));
      const closed = (event: Event | WebSocketMessageEvent | WebSocketCloseEvent) => finish(new Error(`WebSocket closed before initialization${typeof (event as WebSocketCloseEvent).code === "number" ? ` (${(event as WebSocketCloseEvent).code})` : ""}.`));
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", closed, { once: true });
      timer = setTimeout(() => finish(new Error(`Timed out connecting to ${endpoint}.`)), timeoutMs);
    });
    return socket;
  } catch (error) {
    try { socket.close(); } catch { /* best effort before retrying */ }
    throw error;
  }
}

function defaultSpawn(command: string, args: string[], options: SpawnOptionsWithoutStdio): CodexAppServerProcess {
  return spawnChildProcess(command, args, options) as CodexAppServerProcess;
}

function normalizeTurnInput<T extends { input: CodexUserInput[] }>(params: T): T {
  return {
    ...params,
    input: params.input.map((input) => input.type === "text" ? { ...input, text_elements: input.text_elements ?? [] } : input),
  } as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isTurn(value: unknown): value is CodexTurn {
  return isRecord(value)
    && typeof value.id === "string"
    && (value.status === "completed" || value.status === "interrupted" || value.status === "failed" || value.status === "inProgress");
}

function isTerminalTurnStatus(status: CodexTurnStatus): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function nonNegativeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new RangeError("timeoutMs must be a finite non-negative number.");
  return value;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
