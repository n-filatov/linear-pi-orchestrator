import { describe, expect, it } from "vitest";
import { normalizeRelayConfig } from "../src/config/v2.js";
import {
  graphToRelayWorkflow,
  relayWorkflowToGraph,
  validateWorkflowGraph,
  type WorkflowGraph,
} from "../src/workflows/graph.js";

describe("workflow graph adapters", () => {
  const workflow = normalizeRelayConfig({
    version: 2,
    sources: { queue: { use: "command", with: { discover: { command: "/bin/echo" } } } },
    workflows: {
      delivery: {
        enabled: true,
        on: { source: "queue", match: { state: "ready" }, fire: { policy: "on-change" } },
        maxConcurrent: 3,
        targets: { workers: { sourceItem: "current", runs: "active" } },
        timeoutMinutes: 90,
        concurrency: { group: "delivery-{{item.id}}", cancelInProgress: true },
        jobs: {
          implement: {
            use: "launch",
            with: { harness: "codex", prompt: "implement" },
            strategy: { matrix: { model: ["fast", "deep"] }, maxParallel: 1 },
            timeoutMinutes: 30,
          },
          review: {
            use: "command",
            with: { command: "/bin/echo" },
            needs: ["implement.Started", { job: "implement", status: "succeeded" }],
            if: "${{ always() }}",
            continueOnError: true,
          },
        },
      },
    },
  }).workflows.delivery;

  it("round-trips Relay workflow fields through a framework-neutral graph", () => {
    const graph = relayWorkflowToGraph("delivery", workflow);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "__trigger__", kind: "trigger", use: "queue", config: { state: "ready" } }),
      expect.objectContaining({ id: "implement", kind: "action", use: "launch", timeoutMinutes: 30 }),
      expect.objectContaining({ id: "review", condition: "${{ always() }}", continueOnError: true }),
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "__trigger__", target: "implement", condition: "matched" }),
      expect.objectContaining({ source: "implement", target: "review", condition: "started", relayNeed: "implement.Started" }),
      expect.objectContaining({ source: "implement", target: "review", condition: "succeeded", relayNeed: { job: "implement", status: "succeeded" } }),
    ]));
    expect(graphToRelayWorkflow(graph)).toEqual(workflow);
  });

  it("reports unknown nodes and cycles before compiling", () => {
    const graph: WorkflowGraph = {
      id: "bad", enabled: true,
      nodes: [
        { id: "trigger", kind: "trigger", use: "queue", config: {} },
        { id: "a", kind: "action", use: "command", config: {} },
        { id: "b", kind: "action", use: "command", config: {} },
      ],
      edges: [
        { id: "a-b", source: "a", target: "b", condition: "succeeded" },
        { id: "b-a", source: "b", target: "a", condition: "succeeded" },
        { id: "missing", source: "missing", target: "a", condition: "succeeded" },
      ],
    };
    expect(validateWorkflowGraph(graph).map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("cycle"), expect.stringContaining("unknown node"),
    ]));
    expect(() => graphToRelayWorkflow(graph)).toThrow(/Invalid workflow graph/);
  });

  it("keeps reusable workflows as graph settings without inventing jobs", () => {
    const reusable = normalizeRelayConfig({
      version: 2,
      sources: { queue: { use: "command", with: { discover: { command: "/bin/echo" } } } },
      workflows: { review: { on: { source: "queue" }, uses: "./review.yaml", with: { harness: "codex" } } },
    }).workflows.review;
    const graph = relayWorkflowToGraph("review", reusable);
    expect(graph.nodes).toHaveLength(1);
    expect(graphToRelayWorkflow(graph)).toEqual(reusable);
  });
});
