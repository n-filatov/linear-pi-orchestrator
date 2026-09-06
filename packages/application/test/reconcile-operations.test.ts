import { describe, expect, it } from "vitest";
import { ReconcileOperations, type PersistedOperation, type ReconcileOperationsPorts } from "../src/index.js";

const operation: PersistedOperation = { jobId: "deploy", pluginUse: "external", attempt: { attemptId: "attempt-1", leaseExpiresAt: "soon" }, operation: { id: "op-1" } };

function ports(overrides: Partial<ReconcileOperationsPorts<{ ok: boolean }>> = {}) {
  const transitions: Array<{ jobId: string; attemptId: string; value: unknown }> = [];
  const base: ReconcileOperationsPorts<{ ok: boolean }> = {
    listOperations: async () => [operation],
    plugin: () => ({ reconcile: async () => ({ status: "succeeded", output: { ok: true } }), cancel: async () => ({ status: "skipped", message: "stopped" }) }),
    parseOutput: (value) => value as { ok: boolean },
    transition: async (jobId, attemptId, value) => { transitions.push({ jobId, attemptId, value }); },
  };
  return { ports: { ...base, ...overrides }, transitions };
}

describe("ReconcileOperations", () => {
  it("validates output and writes a fenced transition for the persisted attempt", async () => {
    const fixture = ports();
    await expect(new ReconcileOperations(fixture.ports).reconcile()).resolves.toEqual([{ jobId: "deploy", outcome: "transitioned" }]);
    expect(fixture.transitions).toEqual([{ jobId: "deploy", attemptId: "attempt-1", value: { status: "succeeded", output: { ok: true }, message: undefined } }]);
  });

  it("marks missing reconcilers and malformed handles as needing attention", async () => {
    const fixture = ports({ plugin: () => undefined, listOperations: async () => [operation, { ...operation, jobId: "bad", operation: [] }] });
    await expect(new ReconcileOperations(fixture.ports).reconcile()).resolves.toEqual([{ jobId: "deploy", outcome: "needs-attention" }, { jobId: "bad", outcome: "needs-attention" }]);
    expect(fixture.transitions.map((entry) => entry.value)).toEqual([
      { status: "started", needsAttention: true, message: "Action 'external' cannot reconcile its saved operation." },
      { status: "started", needsAttention: true, message: "Action 'external' cannot reconcile its saved operation." },
    ]);
  });

  it("holds an operation for inspection when output validation or observation fails", async () => {
    const fixture = ports({ parseOutput: () => { throw new Error("output schema mismatch"); } });
    await new ReconcileOperations(fixture.ports).reconcile();
    expect(fixture.transitions[0]?.value).toMatchObject({ status: "started", needsAttention: true, message: "Operation reconcile failed: output schema mismatch" });
  });

  it("uses the cancellation observer and reports stale attempt transitions", async () => {
    const fixture = ports({ transition: async () => false });
    await expect(new ReconcileOperations(fixture.ports).cancel()).resolves.toEqual([{ jobId: "deploy", outcome: "stale" }]);
  });
});
