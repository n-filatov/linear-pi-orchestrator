import { describe, expect, it } from "vitest";
import { parseCommandItems } from "../src/sources/command-source.js";
import { LinearMcpSource } from "../src/sources/linear-mcp-source.js";
import type { McpToolClient, McpToolResult } from "../src/sources/mcp-tool-client.js";
import type { RunRecord, TriggerDefinition } from "../src/domain/index.js";

describe("command source protocol", () => {
  it("parses canonical items and enforces the configured source id", () => {
    const items = parseCommandItems(JSON.stringify({ items: [{ sourceId: "queue", id: "A-1", title: "Do work", state: "open" }] }), "queue");
    expect(items[0]).toMatchObject({ sourceId: "queue", id: "A-1", title: "Do work" });
    expect(() => parseCommandItems(JSON.stringify({ items: [{ sourceId: "other", id: "A-1", title: "Do work" }] }), "queue")).toThrow(/unexpected sourceId/);
  });
});

describe("Linear source identity and lifecycle reporting", () => {
  it("uses the human identifier while retaining the provider id for writes", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        if (name === "list_issues") return { structuredContent: [{ id: "uuid-123", identifier: "ENG-123", title: "Keep labels", labels: ["relay:implement"] }] };
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", identifier: "ENG-123", title: "Keep labels", labels: ["relay:implement", "human-added"] } };
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { runningLabel: "relay:running" } });
    const trigger = linearTrigger();
    const [item] = await source.discover({ trigger });

    expect(item).toMatchObject({ id: "ENG-123", metadata: { linearIssueId: "uuid-123", linearIdentifier: "ENG-123" } });
    const run = runFor(item, trigger);
    await source.report({ type: "claimed", sourceId: "linear", run, occurredAt: "now" });

    expect(calls.at(-1)).toEqual({
      name: "save_issue",
      args: { id: "uuid-123", labels: ["relay:implement", "human-added", "relay:running"] },
    });
  });

  it("refetches labels before removing the running label", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: ["relay:running", "human-added"] } };
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { runningLabel: "relay:running" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Keep labels", metadata: { linearIssueId: "uuid-123", linearLabels: ["relay:running"] } };

    await source.report({ type: "stopped", sourceId: "linear", run: runFor(item, trigger), occurredAt: "now" });

    expect(calls.at(-1)).toEqual({ name: "save_issue", args: { id: "uuid-123", labels: ["human-added"] } });
  });

  it("preserves current labels and applies the done label on success", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: ["relay:running", "human-added"] } };
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { runningLabel: "relay:running", doneLabel: "relay:done" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Keep labels", metadata: { linearIssueId: "uuid-123" } };

    await source.report({ type: "succeeded", sourceId: "linear", run: runFor(item, trigger), occurredAt: "now" });

    expect(calls.at(-1)).toEqual({ name: "save_issue", args: { id: "uuid-123", labels: ["human-added", "relay:done"] } });
  });

  it("updates workflow state without sending an empty replacement label list", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { inProgressState: "In Progress" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Keep labels", metadata: { linearIssueId: "uuid-123" } };

    await source.report({ type: "claimed", sourceId: "linear", run: runFor(item, trigger), occurredAt: "now" });

    expect(calls).toEqual([{ name: "save_issue", args: { id: "uuid-123", state: "In Progress" } }]);
  });
});

function linearTrigger(): TriggerDefinition {
  return { id: "linear-ready", sourceId: "linear", repository: { id: "repo", root: "/repo" }, enabled: true };
}

function runFor(item: RunRecord["item"], trigger: TriggerDefinition): RunRecord {
  return {
    id: "run",
    identity: { repository: trigger.repository, sourceId: "linear", itemId: item.id, triggerId: trigger.id },
    item,
    trigger,
    agent: { agentId: "codex" },
    status: "claimed",
    claimedAt: "now",
    updatedAt: "now",
  };
}
