import { describe, expect, it } from "vitest";
import { PollTriggers, type PollResultBase } from "../src/index.js";
type Result = PollResultBase;
const result = (): Result => ({ triggersVisited: 0, itemsDiscovered: 0, runsClaimed: 0, runsLaunched: 0, skipped: 0, actionsExecuted: 0, actionsFailed: 0, items: [] });
describe("PollTriggers", () => {
  it("reconciles durable work before dispatching bindings and isolates failures", async () => {
    const calls: string[] = [];
    const binding = { id: "t", sourceId: "source", repository: { id: "repo", root: "/repo" }, enabled: true };
    const workflow = { id: "w", sourceId: "source", repository: binding.repository, enabled: true, jobs: [] };
    const poll = new PollTriggers<Result>({
      stopSignal: new AbortController().signal, logger: { error: (_message, fields) => calls.push(String(fields?.error)) }, createResult: result,
      markExpiredAttempts: async () => { calls.push("expired"); }, listTriggers: async () => [binding], listWorkflows: async () => [workflow],
      reconcilePersistedRuns: async () => { calls.push("reconciled"); }, runTrigger: async () => { calls.push("trigger"); throw new Error("trigger failed"); },
      runWorkflow: async (_workflow, value) => { calls.push("workflow"); value.actionsExecuted += 1; },
    });
    const value = await poll.execute();
    expect(calls.slice(0, 3)).toEqual(["expired", "reconciled", "trigger"]);
    expect(calls).toContain("workflow"); expect(calls).toContain("trigger failed"); expect(value.actionsExecuted).toBe(1);
  });
});
