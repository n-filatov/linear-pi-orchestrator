import { describe, expect, it } from "vitest";
import {
  actionReferenceFor,
  findDanglingActionReferences,
  findDanglingEdges,
  graphToWorkflow,
  setActionReference,
  syncActionReferenceEdge,
  upstreamReferenceNodes,
  workflowToGraph,
  type GraphNode,
} from "../src/dashboard/client/graph.js";
import { applyCodexModelCatalog } from "../src/dashboard/client/api.js";

function action(id: string, use: string, config: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { id, label: id, use, kind: "action", config: { use, with: {}, ...config } },
  } as GraphNode;
}

describe("dashboard modular action references", () => {
  it("labels Linear workflow triggers for the streamlined canvas", () => {
    const graph = workflowToGraph({ id: "demo", on: { source: "linear" }, jobs: {} });
    expect(graph.nodes[0]?.data.label).toBe("Linear action trigger");
  });

  it("adds the App Server picker values to entry and schema-map catalog formats", () => {
    const configSchema = { type: "object", properties: { model: { type: "string" }, effort: { type: "string" } } };
    const mappedSchema = structuredClone(configSchema);
    const catalog = {
      entries: [{ kind: "action", use: "codex.start-session", configSchema }],
      schemas: { "action:codex.start-session": { schema: mappedSchema } },
    };
    applyCodexModelCatalog(catalog, [
      { id: "terra", model: "gpt-5.6-terra", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    ]);

    expect(configSchema.properties.model).toMatchObject({ title: "Codex model", enum: ["gpt-5.6-terra"], default: "gpt-5.6-terra" });
    expect(configSchema.properties.effort).toMatchObject({ title: "Reasoning effort", enum: ["medium", "high"], default: "medium" });
    expect(mappedSchema.properties.model).toMatchObject({ enum: ["gpt-5.6-terra"] });
  });

  it("offers only preceding Codex sessions and round-trips the selected dependency", () => {
    const nodes = [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { label: "On queue", use: "queue", kind: "trigger", config: {} } },
      action("session", "codex.start-session"),
      action("later-session", "codex.start-session"),
      action("send", "codex.send-prompt"),
    ] as GraphNode[];
    const edges = [{ id: "trigger-send", source: "trigger", target: "send", label: "matched" }];
    expect(upstreamReferenceNodes(nodes, edges, "send", "codex.start-session").map((node) => node.id)).toEqual(["session", "later-session"]);

    const config = setActionReference({ use: "codex.send-prompt", with: { text: "hello" } }, "codex", "session");
    const nextEdges = syncActionReferenceEdge(edges, "send", "codex", undefined, "session");
    const workflow = graphToWorkflow({ nodes: nodes.map((node) => node.id === "send" ? { ...node, data: { ...node.data, config } } : node), edges: nextEdges }, { id: "demo", on: { source: "queue" }, jobs: {} });

    expect(config.with).toEqual({ text: "hello", codex: { action: "session" } });
    expect(nextEdges.find((edge) => edge.source === "session" && edge.target === "send")?.data).toEqual({ relayReferencePath: "codex" });
    expect(nextEdges.find((edge) => edge.source === "session" && edge.target === "send")?.label).toBe("started");
    expect((workflow.jobs as Record<string, unknown>).send).toMatchObject({ with: { text: "hello", codex: { action: "session" } }, needs: "session.started" });
  });

  it("upgrades an existing Codex reference edge to a started dependency", () => {
    const edges = [{ id: "session-send", source: "session", target: "send", label: "succeeded" }];
    expect(syncActionReferenceEdge(edges, "send", "codex", "session", "session")).toEqual([
      expect.objectContaining({ source: "session", target: "send", label: "started", data: { relayReferencePath: "codex" } }),
    ]);
  });

  it("describes terminal and Codex action references", () => {
    expect(actionReferenceFor("worker-send")).toMatchObject({ path: "worker", upstreamUse: "tmux.create-window" });
    expect(actionReferenceFor("codex.start-session")).toMatchObject({ path: "tmux", upstreamUse: "tmux.create-window" });
    expect(actionReferenceFor("codex.send-prompt")).toMatchObject({ path: "codex", upstreamUse: "codex.start-session" });
  });

  it("binds Codex start-session to the selected tmux action and preserves workspace fields", () => {
    const config = setActionReference({ use: "codex.start-session", with: { prompt: "hello", workspace: { baseBranch: "main" } } }, "tmux", "tmux.create-window-2");
    const nodes = [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { label: "On queue", use: "queue", kind: "trigger", config: {} } },
      action("tmux.create-window-2", "tmux.create-window"),
      { ...action("codex.start-session-1", "codex.start-session", config), data: { ...action("codex.start-session-1", "codex.start-session", config).data, config } },
    ] as GraphNode[];
    const edges = syncActionReferenceEdge([{ id: "trigger-tmux", source: "trigger", target: "tmux.create-window-2", label: "matched" }], "codex.start-session-1", "tmux", undefined, "tmux.create-window-2");
    const workflow = graphToWorkflow({ nodes, edges }, { id: "demo", on: { source: "queue" }, jobs: {} });
    expect((workflow.jobs as Record<string, any>) ["codex.start-session-1"]).toMatchObject({
      with: { tmux: { action: "tmux.create-window-2" }, workspace: { baseBranch: "main" } },
      needs: "tmux.create-window-2.started",
    });
    expect(edges.find((edge) => edge.target === "codex.start-session-1")).toMatchObject({ source: "tmux.create-window-2", target: "codex.start-session-1", label: "started" });
  });

  it("resolves dots in job IDs before interpreting a status suffix", () => {
    const graph = workflowToGraph({
      id: "demo", source: "queue", jobs: {
        "tmux.create-window-2": { use: "tmux.create-window" },
        "codex.start-session-1": { use: "codex.start-session", with: { tmux: { action: "tmux.create-window-2" }, prompt: "hello" } },
      },
    });
    expect(graph.edges.find((edge) => edge.source === "tmux.create-window-2" && edge.target === "codex.start-session-1")).toMatchObject({ source: "tmux.create-window-2", label: "started", data: { relayReferencePath: "tmux" } });
    expect(findDanglingEdges(graph.nodes, graph.edges)).toHaveLength(0);
  });

  it("round-trips generic edges to dotted job ids and removes stale legacy duplicates", () => {
    const nodes = [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { label: "On queue", use: "queue", kind: "trigger", config: {} } },
      action("tmux.create-window-1", "tmux.create-window"),
      action("cleanup-2", "cleanup"),
    ] as GraphNode[];
    const edges = [
      { id: "tmux-create-cleanup", source: "tmux.create-window-1", target: "cleanup-2", label: "succeeded" },
      // This is the edge shape emitted by the first dotted-id canvas import.
      { id: "tmux-cleanup", source: "tmux", target: "cleanup-2", label: "succeeded", data: { dangling: true, relayNeed: "tmux" } },
    ];

    const workflow = graphToWorkflow({ nodes, edges }, { id: "demo", jobs: {} });
    expect((workflow.jobs as Record<string, any>)["cleanup-2"].needs).toBe("tmux.create-window-1.succeeded");
  });

  it("keeps standalone cleanup actions independent from the trigger", () => {
    const graph = workflowToGraph({
      id: "cleanup-terminal",
      source: "linear",
      on: { source: "linear", match: { statusTypes: ["completed"] } },
      targets: { workers: { sourceItem: "current", runs: "all" } },
      jobs: { cleanup: { use: "cleanup", with: {} } },
    });
    expect(graph.edges).toHaveLength(0);
    const workflow = graphToWorkflow(graph, { id: "cleanup-terminal", targets: { workers: { sourceItem: "current", runs: "all" } }, jobs: {} });
    expect(workflow.on?.match).toEqual({ statusTypes: ["completed"] });
    expect(workflow.targets).toEqual({ workers: { sourceItem: "current", runs: "all" } });
    expect((workflow.jobs as Record<string, any>).cleanup.needs).toBeUndefined();
  });

  it("reports a removed node's edge as dangling and does not serialize it", () => {
    const nodes = [action("target", "command")];
    const edges = [{ id: "missing-target", source: "missing", target: "target", label: "started" }];
    expect(findDanglingEdges(nodes, edges)).toHaveLength(1);
    const workflow = graphToWorkflow({ nodes, edges }, { id: "demo", jobs: {} });
    expect((workflow.jobs as Record<string, any>).target.needs).toBeUndefined();
  });

  it("reports a reference whose producer was removed or changed", () => {
    const node = action("codex-start", "codex.start-session", { with: { prompt: "hello", tmux: { action: "tmux-window" } } });
    expect(findDanglingActionReferences([node])).toEqual([{ nodeId: "codex-start", path: "tmux", actionId: "tmux-window" }]);
    expect(findDanglingActionReferences([node, action("tmux-window", "command")])).toHaveLength(1);
    expect(findDanglingActionReferences([node, action("tmux-window", "tmux.create-window")])).toHaveLength(0);
  });
});
