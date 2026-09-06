import { describe, expect, it } from "vitest";
import { AdvanceWorkflow, StartWorkflow, type WorkflowEnginePorts, type WorkflowEngineResult } from "../src/index.js";
import type { WorkflowDefinition, WorkflowRunRecord, WorkflowRunStore, WorkItem, WorkSource } from "@task-relay/domain";

const repository = { id: "repo", root: "/repo" };
const workflow: WorkflowDefinition = {
  id: "build", sourceId: "queue", repository, enabled: true,
  firePolicy: "once-per-item", timeoutMs: 100, jobs: [{ id: "deploy", use: "external" }],
};
const item: WorkItem = { sourceId: "queue", id: "same-ticket", title: "Same ticket", triggerEvent: { id: "change-2", payload: { state: "open" } } };
const result = (): WorkflowEngineResult => ({ skipped: 0, actionsExecuted: 0, actionsFailed: 0, items: [] });
const source: WorkSource = { id: "queue", discover: async () => [item], report: async () => {} };

function store(seed?: Partial<WorkflowRunRecord>): WorkflowRunStore & { record?: WorkflowRunRecord } {
  let opened = Boolean(seed);
  const state: WorkflowRunRecord = {
    id: "run", identity: { repository, workflowId: "build", sourceId: "queue", itemId: item.id, occurrence: "event-change-2" }, item,
    status: "running", jobs: { deploy: { status: "pending", attempts: 0 } }, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...seed,
  };
  const api: WorkflowRunStore & { record?: WorkflowRunRecord } = {
    get record() { return state; },
    openWorkflowRun: async (input) => { opened = true; return Object.assign(state, { id: "run", item: input.item, identity: input.identity, definition: input.definition, startedAt: input.startedAt, updatedAt: input.startedAt, concurrencyGroup: input.concurrencyGroup, timeoutAt: input.timeoutAt }); },
    findRunningInGroup: async () => [],
    retryWorkflowJobs: async () => state,
    findWorkflowRun: async () => opened ? state : undefined,
    latestWorkflowRun: async () => undefined,
    updateWorkflowJob: async (_identity, jobId, transition) => { state.jobs[jobId] = { ...state.jobs[jobId], ...transition, attempts: state.jobs[jobId]?.attempts ?? 0 }; state.updatedAt = transition.at; return state; },
    finishWorkflowRun: async (_identity, status, completedAt) => { state.status = status; state.completedAt = completedAt; state.updatedAt = completedAt; return state; },
    listWorkflowRuns: async () => [state],
  };
  return api;
}

function ports(runs: ReturnType<typeof store>, decisions: WorkflowEnginePorts["decisions"]): WorkflowEnginePorts {
  return {
    runs, source: () => source, decisions, now: () => new Date("2026-01-01T00:00:00.050Z"),
    logger: { info: () => {}, warn: () => {}, error: () => {} }, emit: () => {},
    operationContext: () => ({ executionId: "x", actionId: "deploy", triggerId: "build", repository, sourceId: "queue", item, outputs: {}, workers: { launch: async () => ({ status: "skipped" }), cleanup: async () => ({ status: "skipped" }), resolve: async () => [], exec: async () => ({ status: "skipped" }), send: async () => ({ status: "skipped" }), capture: async () => ({ status: "skipped" }), stop: async () => ({ status: "skipped" }), recordOutputs: async () => ({ status: "skipped" }) } }) as never,
    executeJob: async ({ run }) => run,
  };
}

const decisions: WorkflowEnginePorts["decisions"] = {
  decideJob: () => ({ action: "hold", reason: "running" }),
  jobInstances: (jobs) => new Map(jobs.map((job) => [job.id, [job.id]])),
  jobTimedOut: () => false,
  runOutcome: () => ({ done: false, status: "succeeded" }),
  timedOut: () => false,
};

describe("workflow engine", () => {
  it("uses the durable trigger event as the occurrence and snapshots the definition", async () => {
    const runs = store();
    const run = await new StartWorkflow(ports(runs, decisions)).execute({ workflow, item, result: result() });
    expect(run?.identity.occurrence).toBe("event-change-2");
    expect(run?.definition).toEqual(expect.objectContaining({ id: "build" }));
  });

  it("keeps cancellation truthful when an operation has no cancel contract", async () => {
    const runs = store({ jobs: { deploy: { status: "started", attempts: 1, operation: { id: "op" }, attemptId: "attempt-1" } }, timeoutAt: "2025-01-01T00:00:00.000Z" });
    const timedDecisions = { ...decisions, timedOut: () => true };
    const value = await new AdvanceWorkflow(ports(runs, timedDecisions)).execute({ workflow, item, result: result(), run: runs.record! });
    expect(value.jobs.deploy).toMatchObject({ status: "started", needsAttention: true });
    expect(value.status).toBe("running");
  });

  it("does not admit a new concurrency run when the old operation cannot be cancelled", async () => {
    const old = store({ jobs: { deploy: { status: "started", attempts: 1, operation: { id: "op" }, attemptId: "attempt-1" } }, concurrencyGroup: "shared" });
    old.findRunningInGroup = async () => [old.record!];
    const grouped = { ...workflow, concurrency: { group: "shared", cancelInProgress: true } };
    const value = await new StartWorkflow(ports(old, decisions)).execute({ workflow: grouped, item: { ...item, id: "new-ticket" }, result: result() });
    expect(value).toBeUndefined();
    expect(old.record?.identity.itemId).toBe(item.id);
  });
});
