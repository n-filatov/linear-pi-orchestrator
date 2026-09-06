import { describe, expect, it } from "vitest";
import { ExecuteJob } from "../src/index.js";

describe("ExecuteJob", () => {
  it("validates input before claiming an attempt", async () => {
    let claimed = false;
    const job = new ExecuteJob({
      resolveInput: () => ({ invalid: true }),
      parseInput: () => { throw new Error("schema invalid"); },
      claimJob: async () => { claimed = true; return { attemptId: "attempt" }; },
      execute: async () => ({ status: "succeeded" }), parseOutput: (value) => value,
      finishJob: async () => {}, finishUncertain: async () => {},
    });
    await expect(job.execute()).rejects.toThrow("schema invalid");
    expect(claimed).toBe(false);
  });

  it("turns a worker action with no targets into a terminal skipped attempt", async () => {
    const completed: unknown[] = [];
    const job = new ExecuteJob({
      resolveInput: () => ({ ticket: "T-1" }), parseInput: (value) => value as { ticket: string },
      claimJob: async () => ({ attemptId: "job-attempt" }), listTargets: async () => [],
      execute: async () => { throw new Error("must not execute"); }, parseOutput: (value) => value,
      finishJob: async (attemptId, outcome, targets) => { completed.push({ attemptId, outcome, targets }); }, finishUncertain: async () => {},
    });
    await expect(job.execute()).resolves.toMatchObject({ kind: "completed", outcome: { status: "skipped" }, targets: [] });
    expect(completed).toEqual([{ attemptId: "job-attempt", outcome: { status: "skipped", message: "No matching workers." }, targets: [] }]);
  });

  it("records target partial outcomes only after output validation and keeps every attempt fence", async () => {
    const finishedTargets: unknown[] = [];
    const finishedJobs: unknown[] = [];
    const job = new ExecuteJob<{ dryRun: boolean }, { id: number }, string>({
      resolveInput: () => ({ dryRun: false }),
      parseInput: (value) => value as { dryRun: boolean },
      claimJob: async () => ({ attemptId: "job-attempt", leaseExpiresAt: "later" }),
      listTargets: async () => ["worker-a", "worker-b"],
      claimTarget: async (target) => ({ attemptId: `target-${target}` }),
      execute: async ({ target, attempt, targetAttempt }) => target === "worker-a"
        ? { status: "succeeded", output: { id: 1 }, message: attempt.attemptId + targetAttempt?.attemptId }
        : { status: "failed", error: "worker-b failed", output: { id: 2 } },
      parseOutput: (value) => ({ id: (value as { id: number }).id }),
      finishTarget: async (target, attemptId, outcome) => { finishedTargets.push({ target, attemptId, outcome }); },
      finishJob: async (attemptId, outcome, targets) => { finishedJobs.push({ attemptId, outcome, targets }); }, finishUncertain: async () => {},
    });
    const result = await job.execute();
    expect(result).toMatchObject({ kind: "completed", attemptId: "job-attempt", outcome: { status: "failed", error: "worker-b failed" } });
    expect(finishedTargets).toEqual([
      expect.objectContaining({ target: "worker-a", attemptId: "target-worker-a", outcome: expect.objectContaining({ status: "succeeded", output: { id: 1 } }) }),
      expect.objectContaining({ target: "worker-b", attemptId: "target-worker-b", outcome: expect.objectContaining({ status: "failed", output: { id: 2 } }) }),
    ]);
    expect(finishedJobs).toEqual([expect.objectContaining({ attemptId: "job-attempt", outcome: expect.objectContaining({ status: "failed" }) })]);
  });

  it("records a thrown plugin effect as uncertain so it cannot be silently repeated", async () => {
    const uncertain: unknown[] = [];
    let claimed = false;
    let effects = 0;
    const job = new ExecuteJob({
      resolveInput: () => ({ ok: true }), parseInput: (input) => input,
      claimJob: async () => claimed ? undefined : (claimed = true, { attemptId: "attempt" }),
      execute: async () => { effects += 1; throw new Error("plugin exploded after side effect"); }, parseOutput: (value) => value,
      finishJob: async () => {}, finishUncertain: async (attempt, error) => { uncertain.push({ attempt, error }); },
    });
    await expect(job.execute()).resolves.toMatchObject({ kind: "uncertain", error: "plugin exploded after side effect" });
    await expect(job.execute()).resolves.toEqual({ kind: "not_claimed" });
    expect(effects).toBe(1);
    expect(uncertain).toEqual([{ attempt: "attempt", error: "plugin exploded after side effect" }]);
  });

  it("preserves completed target effects when a later target claim is uncertain", async () => {
    const targets: unknown[] = [];
    const uncertain: unknown[] = [];
    const job = new ExecuteJob<string, { worker: string }, string>({
      resolveInput: () => "input", parseInput: (value) => value as string,
      claimJob: async () => ({ attemptId: "job" }), listTargets: async () => ["a", "b"],
      claimTarget: async (target) => target === "a" ? { attemptId: "a-attempt" } : undefined,
      execute: async ({ target }) => ({ status: "succeeded", output: { worker: target! } }),
      parseOutput: (value) => value as { worker: string }, finishJob: async () => {},
      finishTarget: async (target, attemptId, outcome) => { targets.push({ target, attemptId, outcome }); },
      finishUncertain: async (attemptId, error, outcomes) => { uncertain.push({ attemptId, error, outcomes }); },
    });
    await expect(job.execute()).resolves.toMatchObject({ kind: "uncertain", attemptId: "job" });
    expect(targets).toHaveLength(1);
    expect(uncertain).toEqual([expect.objectContaining({ attemptId: "job", outcomes: [expect.objectContaining({ target: "a" })] })]);
  });

  it("aborts the plugin and records uncertainty when a lease heartbeat fails", async () => {
    let observedAbort = false;
    const uncertain: unknown[] = [];
    const job = new ExecuteJob({
      resolveInput: () => ({}), parseInput: (value) => value,
      claimJob: async () => ({ attemptId: "attempt" }),
      execute: async ({ signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        observedAbort = signal.aborted;
        return { status: "succeeded" as const };
      },
      parseOutput: (value) => value, finishJob: async () => {},
      heartbeat: async () => { throw new Error("ledger unavailable"); }, heartbeatIntervalMs: 1,
      finishUncertain: async (attempt, error) => { uncertain.push({ attempt, error }); },
    });
    await expect(job.execute()).resolves.toMatchObject({ kind: "uncertain", attemptId: "attempt" });
    expect(observedAbort).toBe(true);
    expect(uncertain).toEqual([expect.objectContaining({ error: expect.stringContaining("ledger unavailable") })]);
  });

  it("adapts legacy skipped results to a deferred lifecycle when requested", async () => {
    const retryAt = "2026-09-06T12:00:00.000Z";
    const job = new ExecuteJob({
      resolveInput: () => ({}), parseInput: (value) => value,
      claimJob: async () => ({ attemptId: "attempt" }),
      execute: async () => ({ status: "skipped", message: "not ready" }),
      adaptOutcome: (outcome) => ({ status: "deferred", retryAt, reason: ("message" in outcome ? outcome.message : undefined) ?? "deferred", output: outcome.output }),
      parseOutput: (value) => value, finishJob: async () => {}, finishUncertain: async () => {},
    });
    await expect(job.execute()).resolves.toMatchObject({ kind: "completed", outcome: { status: "deferred", retryAt } });
  });
});
