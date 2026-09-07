import { randomUUID } from "node:crypto";
import type { CodexAppServerClient, CodexAppServerServerRequest, CodexJsonValue } from "./app-server-client.js";

export type PendingCodexApproval = {
  id: string;
  workerId: string;
  repositoryRoot: string;
  method: string;
  params: Record<string, CodexJsonValue>;
  createdAt: string;
  expiresAt: string;
};
type Pending = { view: PendingCodexApproval; request: CodexAppServerServerRequest; client: CodexAppServerClient; timer: NodeJS.Timeout };
const supported = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]);
const pending = new Map<string, Pending>();

export function listCodexApprovals(): PendingCodexApproval[] { return [...pending.values()].map((entry) => entry.view); }
export function resolveCodexApproval(id: string, decision: "accept" | "decline"): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  const { request, client, view } = entry;
  const result: CodexJsonValue = request.method === "item/permissions/requestApproval"
    ? { permissions: decision === "accept" ? view.params.permissions ?? {} : {}, scope: "turn" }
    : { decision };
  client.respond(request.id, result);
  remove(id);
  return true;
}
function remove(id: string): void {
  const entry = pending.get(id);
  if (entry) clearTimeout(entry.timer);
  pending.delete(id);
}

export function attachCodexApprovals(client: CodexAppServerClient, workerId: string, repositoryRoot: string): () => void {
  const clear = () => {
    for (const [id, entry] of pending) if (entry.client === client) remove(id);
  };
  const offRequest = client.onServerRequest((request) => {
    if (!supported.has(request.method)) {
      client.respondError(request.id, `Relay cannot handle ${request.method}. Use the attached Codex UI for this interaction.`, -32601);
      return;
    }
    const params = request.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      client.respondError(request.id, "Malformed approval request.", -32602);
      return;
    }
    const id = randomUUID();
    const timeoutMs = 10 * 60_000;
    const timer = setTimeout(() => {
      try { resolveCodexApproval(id, "decline"); } catch { remove(id); }
    }, timeoutMs);
    timer.unref();
    pending.set(id, { request, client, timer, view: {
      id, workerId, repositoryRoot, method: request.method, params,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    } });
  });
  const offNotification = client.onNotification((notification) => {
    if (notification.method !== "serverRequest/resolved") return;
    const params = notification.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return;
    for (const [id, entry] of pending) {
      if (entry.client === client && entry.request.id === params.requestId) remove(id);
    }
  });
  const offError = client.onError(clear);
  return () => {
    for (const [id, entry] of pending) {
      if (entry.client !== client) continue;
      try { resolveCodexApproval(id, "decline"); } catch { remove(id); }
    }
    offRequest(); offNotification(); offError(); clear();
  };
}
