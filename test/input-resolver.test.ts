import { describe, expect, it } from "vitest";
import { resolveWorkflowInputs, validateWorkflowInputReferences, WorkflowInputResolutionError, type WorkflowInputContext } from "../src/workflows/input-resolver.js";

const context: WorkflowInputContext = {
  trigger: { payload: { count: 3, enabled: true, nested: { name: "payload" } } },
  item: { id: "ENG-7", title: "Fix relay" },
  needs: { build: { outputs: { artifact: "dist/app", size: 12 } } },
  matrix: { os: "linux" },
  repository: { id: "acme/app", root: "/repo" },
};

describe("workflow input resolver", () => {
  it("provides all documented contexts and preserves exact expression types", () => {
    expect(resolveWorkflowInputs({
      count: "${{ trigger.payload.count }}",
      enabled: "${{ trigger.payload.enabled }}",
      output: "${{ needs.build.outputs.size }}",
      item: "${{ item.id }}",
      matrix: "${{ matrix.os }}",
      repo: "${{ repository.id }}",
    }, context, { jobId: "review", declaredNeeds: ["build"] })).toEqual({ count: 3, enabled: true, output: 12, item: "ENG-7", matrix: "linux", repo: "acme/app" });
  });

  it("turns mixed expressions into one string", () => {
    expect(resolveWorkflowInputs({ text: "${{ item.id }} on ${{ matrix.os }} (${{ needs.build.outputs.size }})" }, context, { declaredNeeds: ["build"] })).toEqual({ text: "ENG-7 on linux (12)" });
  });

  it("rejects undeclared needs and missing values with job paths", () => {
    expect(() => resolveWorkflowInputs({ with: { prompt: "${{ needs.test.outputs.result }}" } }, context, { jobId: "review", declaredNeeds: ["build"] })).toThrow(/review\.with\.prompt: undeclared needs reference 'test'/);
    expect(() => resolveWorkflowInputs({ with: { prompt: "${{ trigger.payload.absent }}" } }, context, { jobId: "review" })).toThrow(/review\.with\.prompt: missing required value/);
    expect(() => resolveWorkflowInputs({ with: { prompt: "${{ needs.build.outputs.absent }}" } }, context, { jobId: "review", declaredNeeds: ["build"] })).toThrow(WorkflowInputResolutionError);
  });

  it("supports bracketed dotted job names and ignores quoted text during preflight", () => {
    expect(resolveWorkflowInputs({ value: "${{ needs['build.release'].outputs.artifact }}" }, {
      ...context, needs: { "build.release": { outputs: { artifact: "app" } } },
    }, { declaredNeeds: ["build.release"] })).toEqual({ value: "app" });
    expect(() => validateWorkflowInputReferences({ value: "${{ needs['other.release'].outputs.x }}" }, ["build.release"], "review"))
      .toThrow(/review\.value: undeclared needs reference 'other\.release'/);
    expect(() => validateWorkflowInputReferences({ value: "${{ 'needs.fake.outputs.x' }}" }, [], "review")).not.toThrow();
  });

  it("rejects malformed interpolation and preserves explicit null", () => {
    expect(resolveWorkflowInputs({ value: "${{ null }}" }, context)).toEqual({ value: null });
    expect(() => validateWorkflowInputReferences({ value: "prefix ${{ item.id" }, [], "review")).toThrow(/malformed expression delimiters/);
  });
});
