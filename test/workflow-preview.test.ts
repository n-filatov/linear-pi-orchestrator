import { describe, expect, it } from "vitest";
import { previewDecision } from "../src/app.js";

const item = { id: "ENG-1", sourceId: "queue", title: "Ticket" };
const job = { id: "notify", use: "notify" };
const base = { job, item, known: new Set(["notify"]), instances: new Map<string, string[]>() };

describe("workflow preview eligibility", () => {
  it("fences disabled workflows and uncertain or owned attempts before DAG evaluation", () => {
    expect(previewDecision({ ...base, enabled: false, states: {} })).toMatchObject({ action: "hold", reason: "workflow is disabled" });
    expect(previewDecision({ ...base, enabled: true, states: { notify: { status: "pending", attempts: 1, attemptId: "attempt-1" } } })).toMatchObject({ action: "hold", reason: "An attempt owns this job." });
    expect(previewDecision({ ...base, enabled: true, states: { notify: { status: "pending", attempts: 1, needsAttention: true } } })).toMatchObject({ action: "hold" });
  });

  it("fences a future deferred retry instead of claiming it runnable", () => {
    expect(previewDecision({ ...base, enabled: true, states: { notify: { status: "pending", attempts: 1, retryAt: "2999-01-01T00:00:00.000Z" } } })).toMatchObject({ action: "hold", reason: "Deferred until 2999-01-01T00:00:00.000Z" });
  });
});
