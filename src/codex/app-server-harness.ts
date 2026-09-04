import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkerCompletion, WorkerHandle } from "../domain/index.js";
import type { HarnessLaunchRequest, HarnessPlugin } from "../plugins/index.js";
import { CodexAppServerClient, type CodexTurn, type CodexTurnStatus } from "./app-server-client.js";

/** Reserved, automatically composed harness id used by the codex.* actions. */
export const CODEX_APP_SERVER_HARNESS_ID = "__codex_app_server";

export type CodexAppServerWorkerMetadata = {
  transport: "stdio" | "websocket";
  threadId: string;
  turnId: string;
  workspace: string;
  model?: string;
  effort?: string;
  /** Loopback-only endpoint used by the visible `codex --remote` tmux TUI. */
  endpoint?: string;
  tmux?: { action: string; workerId: string; session: string; target: string };
};

export type CodexAppServerPromptOptions = {
  prompt: string;
  model?: string;
  effort?: string;
  delivery: "idle" | "immediate";
  waitForCompletion?: boolean;
  timeoutMs: number;
};

type Session = {
  client: CodexAppServerClient;
  threadId: string;
  activeTurnId?: string;
  lastTurn?: CodexTurn;
};

const harnessConfigSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
}).strict().default({});

/**
 * Owns stdio App Server processes for the lifetime of the current Relay
 * process. A stdio connection cannot be reattached after a Relay restart, so
 * reconcile deliberately fails those persisted workers instead of guessing.
 */
export class CodexAppServerHarness implements HarnessPlugin<z.infer<typeof harnessConfigSchema>> {
  readonly kind = "harness" as const;
  readonly use = CODEX_APP_SERVER_HARNESS_ID;
  readonly configSchema = harnessConfigSchema;
  readonly presentation = {
    name: "Codex App Server",
    description: "Run a Codex thread through the supported JSONL stdio App Server transport.",
    category: "Workers",
    icon: "bot",
    color: "#10a37f",
  };

  private readonly sessions = new Map<string, Session>();

  async launch(request: HarnessLaunchRequest<z.infer<typeof harnessConfigSchema>>): Promise<WorkerHandle> {
    const tmux = remoteTui(request.harnessInput);
    const remote = tmux
      ? await CodexAppServerClient.startRemote({
        command: request.config.command,
        ...(request.config.args.length ? { args: request.config.args } : {}),
        cwd: request.workspace.path,
        initialize: { clientInfo: { name: "task_relay", title: "Task Relay", version: "0.1.0" } },
      })
      : undefined;
    const client = remote?.client ?? await CodexAppServerClient.start({
      command: request.config.command,
      ...(request.config.args.length ? { args: request.config.args } : {}),
      cwd: request.workspace.path,
      initialize: { clientInfo: { name: "task_relay", title: "Task Relay", version: "0.1.0" } },
    });
    try {
      const started = await client.startThread({
        cwd: request.workspace.path,
        ...(request.model ? { model: request.model } : {}),
        approvalPolicy: "never",
        // The installed Codex App Server accepts CLI-style sandbox variants.
        // Keep this aligned with its runtime schema (`workspace-write`).
        sandbox: "workspace-write",
      });
      const threadId = started.thread.id;
      const turn = await client.requestTurn({
        threadId,
        cwd: request.workspace.path,
        ...(request.model ? { model: request.model } : {}),
        ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
        input: [{ type: "text", text: request.prompt }],
      });
      const turnId = turn.turn.id;
      this.sessions.set(request.workerId, { client, threadId, activeTurnId: turnId });
      return this.worker(request, threadId, turnId, remote?.endpoint, tmux);
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    }
  }

  async sendPrompt(worker: WorkerHandle, options: CodexAppServerPromptOptions): Promise<{ threadId: string; turnId: string; delivery: "idle" | "immediate"; turnStatus?: CodexTurnStatus }> {
    const session = await this.requireSession(worker);
    const lifecycle = session.client.lifecycle(session.threadId);
    const lastTurn = lifecycle?.lastTurn;
    const activeTurnId = lifecycle?.activeTurnId
      ?? (lastTurn && lastTurn.id === session.activeTurnId && lastTurn.status !== "inProgress" ? undefined : session.activeTurnId);
    let turnId: string;
    if (options.delivery === "immediate" && activeTurnId) {
      const steered = await session.client.steerTurn({
        threadId: session.threadId,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text: options.prompt }],
      });
      turnId = steered.turnId;
    } else {
      if (options.delivery === "idle" && activeTurnId) {
        await this.withTimeout(this.waitForTurn(session, activeTurnId), options.timeoutMs, "Codex turn did not become idle before the prompt timeout.");
      }
      const started = await session.client.requestTurn({
        threadId: session.threadId,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        input: [{ type: "text", text: options.prompt }],
      });
      turnId = started.turn.id;
    }
    session.activeTurnId = turnId;
    if (!options.waitForCompletion) return { threadId: session.threadId, turnId, delivery: options.delivery };
    const completed = await this.withTimeout(
      this.waitForTurn(session, turnId),
      options.timeoutMs,
      `Codex turn ${turnId} did not complete before the prompt timeout.`,
    );
    if (completed.status !== "completed") throw new Error(completionFor(completed).error ?? `Codex turn ${turnId} ${completed.status}.`);
    return { threadId: session.threadId, turnId, delivery: options.delivery, turnStatus: completed.status };
  }

  async wait(worker: WorkerHandle): Promise<WorkerCompletion | undefined> {
    let session: Session;
    try { session = await this.requireSession(worker); }
    catch (error) { return { status: "failed", error: error instanceof Error ? error.message : String(error) }; }
    if (!session.activeTurnId) return session.lastTurn ? completionFor(session.lastTurn) : { status: "succeeded" };
    const turn = await this.waitForTurn(session, session.activeTurnId);
    return completionFor(turn);
  }

  async reconcile(worker: WorkerHandle): Promise<WorkerCompletion | undefined> {
    try {
      const session = await this.requireSession(worker);
      if (!session.activeTurnId) return session.lastTurn ? completionFor(session.lastTurn) : { status: "succeeded" };
      return undefined;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(worker: WorkerHandle): Promise<void> {
    let session: Session;
    try { session = await this.requireSession(worker); }
    catch { return; }
    try {
      const lifecycle = session.client.lifecycle(session.threadId);
      const turnId = lifecycle?.activeTurnId ?? session.activeTurnId;
      if (turnId) await session.client.interruptTurn({ threadId: session.threadId, turnId }).catch(() => undefined);
    } finally {
      this.sessions.delete(worker.id);
      await session.client.stop();
    }
  }

  private worker(
    request: HarnessLaunchRequest<z.infer<typeof harnessConfigSchema>>,
    threadId: string,
    turnId: string,
    endpoint?: string,
    tmux?: NonNullable<ReturnType<typeof remoteTui>>,
  ): WorkerHandle {
    const codex: CodexAppServerWorkerMetadata = {
      transport: "stdio",
      threadId,
      turnId,
      workspace: request.workspace.path,
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(tmux ? { transport: "websocket" as const, tmux } : {}),
    };
    return {
      id: request.workerId || `codex-app-server-${randomUUID()}`,
      startedAt: new Date().toISOString(),
      // The App Server owns its own stdio child and can outlive a single Relay
      // tick; the observer remains attached but must not make `relay once`
      // wait for an agent turn to finish.
      metadata: { persistent: true, workspace: request.workspace.path, codexAppServer: codex },
    };
  }

  private async requireSession(worker: WorkerHandle): Promise<Session> {
    const existing = this.sessions.get(worker.id);
    if (existing) return existing;
    const metadata = codexMetadata(worker);
    if (!metadata) throw new Error(`Worker ${worker.id} does not contain resumable Codex App Server metadata.`);

    // App Server threads are durable even though their JSONL connection is
    // not. A fresh Relay process can therefore create a new stdio client and
    // resume the persisted thread by id instead of declaring the worker lost.
    const client = metadata.transport === "websocket"
      ? (await CodexAppServerClient.startRemote({
        endpoint: metadata.endpoint,
        cwd: metadata.workspace,
        initialize: { clientInfo: { name: "task_relay", title: "Task Relay", version: "0.1.0" } },
      })).client
      : await CodexAppServerClient.start({
        cwd: metadata.workspace,
        initialize: { clientInfo: { name: "task_relay", title: "Task Relay", version: "0.1.0" } },
      });
    try {
      const resumed = await client.resumeThread({
        threadId: metadata.threadId,
        cwd: metadata.workspace,
        ...(metadata.model ? { model: metadata.model } : {}),
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
      const lastTurn = resumed.thread.turns?.at(-1);
      const session: Session = {
        client,
        threadId: metadata.threadId,
        ...(lastTurn ? { lastTurn } : {}),
        ...(lastTurn?.status === "inProgress" ? { activeTurnId: lastTurn.id } : {}),
      };
      this.sessions.set(worker.id, session);
      return session;
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw new Error(`Could not resume Codex thread ${metadata.threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops every App Server process owned by this process. */
  async closeAll(): Promise<void> {
    const workers = [...this.sessions.keys()];
    await Promise.all(workers.map(async (workerId) => {
      const session = this.sessions.get(workerId);
      if (!session) return;
      this.sessions.delete(workerId);
      const lifecycle = session.client.lifecycle(session.threadId);
      const turnId = lifecycle?.activeTurnId ?? session.activeTurnId;
      if (turnId) await session.client.interruptTurn({ threadId: session.threadId, turnId }).catch(() => undefined);
      await session.client.stop().catch(() => undefined);
    }));
  }

  private async waitForTurn(session: Session, turnId: string): Promise<CodexTurn> {
    const turn = await session.client.waitForTurn(session.threadId, turnId, { timeoutMs: 86_400_000 });
    session.lastTurn = turn;
    if (session.activeTurnId === turnId) session.activeTurnId = undefined;
    return turn;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function codexMetadata(worker: WorkerHandle): CodexAppServerWorkerMetadata | undefined {
  const value = worker.metadata?.codexAppServer;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = value as Partial<CodexAppServerWorkerMetadata>;
  return (metadata.transport === "stdio" || metadata.transport === "websocket")
    && typeof metadata.threadId === "string"
    && typeof metadata.turnId === "string"
    && typeof metadata.workspace === "string"
    && (metadata.transport !== "websocket" || typeof metadata.endpoint === "string")
    ? metadata as CodexAppServerWorkerMetadata
    : undefined;
}

function remoteTui(input: Record<string, unknown> | undefined): { action: string; workerId: string; session: string; target: string } | undefined {
  const value = input?.remoteTui;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.action !== "string" || typeof candidate.workerId !== "string" || typeof candidate.session !== "string" || typeof candidate.target !== "string") {
    throw new Error("Codex remote tmux binding is invalid: action, workerId, session, and target are required.");
  }
  return { action: candidate.action, workerId: candidate.workerId, session: candidate.session, target: candidate.target };
}

function completionFor(turn: CodexTurn): WorkerCompletion {
  if (turn.status === "completed") return { status: "succeeded" };
  const status: CodexTurnStatus = turn.status;
  const error = typeof turn.error === "string" ? turn.error : `Codex turn ${turn.id} ${status}.`;
  return { status: "failed", error };
}
