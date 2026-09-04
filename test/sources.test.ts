import { describe, expect, it } from "vitest";
import { parseCommandItems } from "../src/sources/command-source.js";
import { LinearMcpSource, isLinearTriggerSelector, parseLinearTriggerSelector } from "../src/sources/linear-mcp-source.js";
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
  it("loads labels, workflow statuses, and users for the trigger editor", async () => {
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        if (name === "list_issue_labels") return args.cursor === "labels-page-2"
          ? { structuredContent: { labels: [{ name: "relay:test" }] } }
          : { structuredContent: { labels: [{ name: "AI" }, { id: "id-only-related-record" }, { name: "team:platform" }], nextCursor: "labels-page-2" } };
        if (name === "list_teams") return { structuredContent: { teams: [{ id: "team-eng" }, { id: "team-product" }] } };
        if (name === "list_issue_statuses") return { structuredContent: { statuses: args.team === "team-eng" ? [{ name: "In Progress", type: "started" }, { name: "Done", type: "completed" }] : [{ name: "Done", type: "completed" }, { name: "Triage", type: "triage" }] } };
        if (name === "list_users") return { structuredContent: { users: [{ id: "user-1", name: "Ada Lovelace" }] } };
        throw new Error(`unexpected tool ${name}`);
      },
    };
    const options = await new LinearMcpSource({ id: "linear", client }).triggerOptions();
    expect(options).toEqual({
      labels: ["AI", "relay:test", "team:platform"],
      statuses: [{ name: "Done", type: "completed" }, { name: "In Progress", type: "started" }, { name: "Triage", type: "triage" }],
      users: [{ id: "user-1", name: "Ada Lovelace" }],
    });
  });

  it("owns label, workflow-state, and state-type matching while using safe list filters", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        return {
          structuredContent: [
            {
              id: "uuid-123",
              identifier: "ENG-123",
              title: "Eligible",
              updatedAt: "2026-08-15T12:00:00.000Z",
              labels: ["relay:implement", "team:platform"],
              status: { name: "In Progress", type: "started" },
            },
            {
              id: "uuid-456",
              identifier: "ENG-456",
              title: "Excluded label",
              labels: ["relay:implement", "relay:blocked"],
              status: { name: "In Progress", type: "started" },
            },
            {
              id: "uuid-789",
              identifier: "ENG-789",
              title: "Wrong state type",
              labels: ["relay:implement", "team:platform"],
              status: { name: "Done", type: "completed" },
            },
          ],
        };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client });
    const trigger = {
      ...linearTrigger(),
      selector: {
        labels: { all: ["relay:implement", "team:platform"], any: ["team:platform", "team:api"], none: ["relay:blocked"] },
        statuses: ["In Progress"],
        statusTypes: ["started"],
      },
    };

    const items = await source.discover({ trigger });

    expect(items.map((item) => item.id)).toEqual(["ENG-123"]);
    expect(items[0]?.metadata).toMatchObject({ linearStatus: "In Progress", linearStatusType: "started", linearUpdatedAt: "2026-08-15T12:00:00.000Z" });
    expect(calls[0]).toEqual({
      name: "list_issues",
      args: { label: "relay:implement", state: "In Progress", limit: 50, includeArchived: false, orderBy: "updatedAt" },
    });
  });

  it("keeps OR label matching local when it cannot be expressed as one Linear list filter", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        return { structuredContent: [{ id: "uuid-123", identifier: "ENG-123", title: "API task", labels: ["team:api"], status: "Todo" }] };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client });
    const trigger = { ...linearTrigger(), selector: { labels: { any: ["team:api", "team:platform"] }, status: "Todo" } };

    const [item] = await source.discover({ trigger });

    expect(item?.id).toBe("ENG-123");
    expect(calls[0]?.args).toEqual({ state: "Todo", limit: 50, includeArchived: false, orderBy: "updatedAt" });
  });

  it("normalises existing selector shorthands", () => {
    expect(parseLinearTriggerSelector({ label: "relay:implement", excludeLabels: ["relay:running"], status: "Todo", statusType: "unstarted" })).toEqual({
      label: "relay:implement",
      statuses: ["Todo"],
      statusTypes: ["unstarted"],
      excludeLabels: ["relay:running"],
    });
    expect(isLinearTriggerSelector({ labels: { all: ["relay:implement"] }, statuses: ["Todo"] })).toBe(true);
    expect(isLinearTriggerSelector({ labels: { all: [1] } })).toBe(false);
  });

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
