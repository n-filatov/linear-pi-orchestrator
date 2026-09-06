import { describe, expect, it } from "vitest";
import type { TriggerDefinition, WorkflowJobState } from "@task-relay/domain";
import {
  LEGACY_CONTINUE_CONDITION,
  LEGACY_PIPELINE_COMPATIBILITY,
  legacyPipelineToWorkflow,
} from "../src/index.js";
import { decideJob } from "../../../src/workflows/reconciler.js";

const repository = { id: "relay", root: "/tmp/relay" };

function trigger(actions: NonNullable<TriggerDefinition["actions"]>): TriggerDefinition {
  return {
    id: "ordered",
    sourceId: "queue",
    repository,
    enabled: true,
    selector: { label: "ready" },
    maxConcurrent: 2,
    targets: { workers: { sourceItem: "current", runs: "all", workerIds: ["worker-1"] } },
    firePolicy: "on-change",
    metadata: { owner: "legacy" },
    actions,
  };
}

function state(status: WorkflowJobState["status"]): WorkflowJobState {
  return { status, attempts: 1 };
}

describe("legacy ordered pipeline adapter", () => {
  it("normalizes order into a single workflow chain and retains trigger scope", () => {
    const workflow = legacyPipelineToWorkflow(trigger([
      { id: "launch", use: "launch", config: { prompt: "Implement {{item.id}}" } },
      { id: "review", use: "worker-send", config: { text: "Review" }, continueOnError: true },
      { id: "cleanup", use: "cleanup", config: { activeWorker: "stop" } },
    ]));

    expect(workflow).toMatchObject({
      id: "ordered",
      sourceId: "queue",
      repository,
      enabled: true,
      selector: { label: "ready" },
      maxConcurrent: 2,
      targets: { workers: { runs: "all", workerIds: ["worker-1"] } },
      firePolicy: "on-change",
      metadata: {
        owner: "legacy",
        legacyPipeline: {
          mode: LEGACY_PIPELINE_COMPATIBILITY,
          version: 1,
          triggerId: "ordered",
          actionIds: ["launch", "review", "cleanup"],
          includeWorkerGeneration: true,
        },
      },
    });
    expect(workflow.jobs).toEqual([
      { id: "launch", use: "launch", config: { prompt: "Implement {{item.id}}" }, continueOnError: false },
      { id: "review", use: "worker-send", config: { text: "Review" }, needs: [{ job: "launch" }], continueOnError: true },
      { id: "cleanup", use: "cleanup", config: { activeWorker: "stop" }, needs: [{ job: "review" }], if: LEGACY_CONTINUE_CONDITION, continueOnError: false },
    ]);
  });

  it("keeps the legacy failure and continue-on-error traversal", () => {
    const workflow = legacyPipelineToWorkflow(trigger([
      { id: "first", use: "command" },
      { id: "second", use: "command", continueOnError: true },
      { id: "third", use: "command" },
    ]));
    const item = { sourceId: "queue", id: "Q-1", title: "queue item" };
    const known = new Set(workflow.jobs.map((job) => job.id));

    // A failed action without continueOnError stops the old pipeline: the
    // following job is omitted by the regular success dependency.
    expect(decideJob({ job: workflow.jobs[1], states: { first: state("failed") }, item, known })).toMatchObject({
      action: "settle", status: "omitted",
    });

    // A failed action with continueOnError still lets the next action run.
    expect(decideJob({ job: workflow.jobs[2], states: { second: state("failed") }, item, known })).toEqual({ action: "run" });
  });

  it("combines a predecessor continuation with the next action's condition", () => {
    const workflow = legacyPipelineToWorkflow(trigger([
      { id: "first", use: "command", continueOnError: true },
      { id: "second", use: "command", if: "${{ needs.first.outputs.ready }}" },
    ]));
    expect(workflow.jobs[1]?.if).toBe("${{ always() && (needs.first.outputs.ready) }}");
  });

  it("treats a skipped worker action as a completed predecessor", () => {
    const workflow = legacyPipelineToWorkflow(trigger([
      { id: "workers", use: "cleanup" },
      { id: "notify", use: "command" },
    ]));
    const item = { sourceId: "queue", id: "Q-1", title: "queue item" };
    expect(decideJob({
      job: workflow.jobs[1],
      states: { workers: state("skipped") },
      item,
      known: new Set(workflow.jobs.map((job) => job.id)),
    })).toEqual({ action: "run" });
  });

  it("rejects malformed or duplicate action ids before a run can be opened", () => {
    expect(() => legacyPipelineToWorkflow(trigger([
      { id: "same", use: "command" },
      { id: "same", use: "command" },
    ]))).toThrow("uses action id 'same' more than once");
    expect(() => legacyPipelineToWorkflow(trigger([{ id: " ", use: "command" }]))).toThrow("must have a non-empty id");
    expect(() => legacyPipelineToWorkflow({ ...trigger([]), actions: [] })).toThrow("has no actions");
  });
});
