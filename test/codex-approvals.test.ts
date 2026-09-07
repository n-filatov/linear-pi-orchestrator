import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachCodexApprovals, listCodexApprovals, resolveCodexApproval } from "../src/codex/approvals.js";
import { CodexAppServerClient, type CodexAppServerProcess } from "../src/codex/app-server-client.js";

const cleanup: Array<() => void> = [];
function fixture() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const replies: unknown[] = [];
  process.stdin.on("data", (data) => replies.push(JSON.parse(data.toString())));
  const client = new CodexAppServerClient(process as unknown as CodexAppServerProcess);
  const detach = attachCodexApprovals(client, "worker-1", "/repo");
  cleanup.push(detach);
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  return { replies, send, detach };
}
afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); vi.useRealTimers(); });
describe("Codex approval queue", () => {
  it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])("requires an explicit decision for %s", (method) => {
    const { replies, send } = fixture();
    send({ id: "request-1", method, params: { threadId: "thread-1", command: "tmux list-panes" } });
    const approval = listCodexApprovals()[0];
    expect(approval).toMatchObject({ workerId: "worker-1", repositoryRoot: "/repo", method });
    expect(replies).toEqual([]);
    expect(resolveCodexApproval(approval.id, "accept")).toBe(true);
    expect(replies).toEqual([{ id: "request-1", result: { decision: "accept" } }]);
    expect(resolveCodexApproval(approval.id, "accept")).toBe(false);
  });
  it("grants only the requested permissions for one turn", () => {
    const { replies, send } = fixture();
    send({ id: 1, method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } } } });
    resolveCodexApproval(listCodexApprovals()[0].id, "accept");
    expect(replies).toEqual([{ id: 1, result: { permissions: { network: { enabled: true } }, scope: "turn" } }]);
  });
  it("removes requests answered by the remote TUI without responding again", () => {
    const { replies, send } = fixture();
    send({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1" } });
    send({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 1 } });
    expect(listCodexApprovals()).toEqual([]);
    expect(replies).toEqual([]);
  });
  it("declines expired requests instead of leaving a session blocked forever", () => {
    vi.useFakeTimers();
    const { replies, send } = fixture();
    send({ id: 1, method: "item/fileChange/requestApproval", params: {} });
    vi.advanceTimersByTime(10 * 60_000);
    expect(replies).toEqual([{ id: 1, result: { decision: "decline" } }]);
    expect(listCodexApprovals()).toEqual([]);
  });
  it("declines pending requests on detach and errors on unsupported interactions", () => {
    const { replies, send, detach } = fixture();
    send({ id: 1, method: "item/fileChange/requestApproval", params: {} });
    detach();
    expect(replies).toContainEqual({ id: 1, result: { decision: "decline" } });
    const other = fixture();
    other.send({ id: 2, method: "unknown/request", params: {} });
    expect(other.replies).toEqual([expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32601 }) })]);
  });
});
