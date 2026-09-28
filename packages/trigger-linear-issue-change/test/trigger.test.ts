import { describe, expect, it } from "vitest";
import { isLinearTriggerSelector, parseLinearTriggerSelector, LinearMcpSource } from "../src/index.js";
import type { McpToolClient, McpToolResult } from "@task-relay/integration-linear";
import type { RunRecord, TriggerDefinition } from "@task-relay/domain";

describe("Linear trigger selector", () => {
  it("retains supported legacy aliases and ignores unknown fields", () => {
    expect(parseLinearTriggerSelector({ label: "ready", excludeLabels: ["blocked"] })).toMatchObject({ label: "ready", excludeLabels: ["blocked"] });
    expect(isLinearTriggerSelector({ labels: { any: ["ready"] } })).toBe(true);
    expect(isLinearTriggerSelector({ unexpected: true })).toBe(true);
  });
});

describe("Linear source handoff comment reporting", () => {
  it("posts a comment with session link and brief on succeeded event when commentOnHandoff is true", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { commentOnHandoff: true } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger, {
      worker: {
        id: "worker-1",
        startedAt: "now",
        metadata: {
          outputs: {
            claudeSession: {
              link: "https://claude.ai/artifact/abc123",
              lastResult: "Task completed successfully. Here is the summary.",
            },
          },
        },
      },
    });

    await source.report({ type: "succeeded", sourceId: "linear", run, occurredAt: "now" });

    const commentCall = calls.find((c) => c.name === "save_comment");
    expect(commentCall).toBeDefined();
    expect(commentCall?.args.issueId).toBe("uuid-123");
    expect(commentCall?.args.body).toContain("Ready for review in the Claude app.");
    expect(commentCall?.args.body).toContain("Open the session: https://claude.ai/artifact/abc123");
    expect(commentCall?.args.body).toContain("## Review brief");
    expect(commentCall?.args.body).toContain("Task completed successfully");
  });

  it("posts a comment with session link on failed event", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { commentOnHandoff: true } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger, {
      worker: {
        id: "worker-1",
        startedAt: "now",
        metadata: {
          outputs: {
            claudeSession: {
              link: "https://claude.ai/artifact/def456",
              lastResult: "Step 2 encountered an error.",
            },
          },
        },
      },
    });

    await source.report({ type: "failed", sourceId: "linear", run, occurredAt: "now" });

    const commentCall = calls.find((c) => c.name === "save_comment");
    expect(commentCall).toBeDefined();
    expect(commentCall?.args.body).toContain("Relay stopped at a failed step. Continue in the Claude app.");
    expect(commentCall?.args.body).toContain("Open the session: https://claude.ai/artifact/def456");
    expect(commentCall?.args.body).toContain("## Review brief");
  });

  it("does not post handoff comment when commentOnHandoff is false", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { commentOnHandoff: false } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger, {
      worker: {
        id: "worker-1",
        startedAt: "now",
        metadata: {
          outputs: {
            claudeSession: {
              link: "https://claude.ai/artifact/ghi789",
            },
          },
        },
      },
    });

    await source.report({ type: "succeeded", sourceId: "linear", run, occurredAt: "now" });

    const commentCall = calls.find((c) => c.name === "save_comment" && c.args.body?.toString().includes("Ready for review"));
    expect(commentCall).toBeUndefined();
  });

  it("does not post handoff comment when worker has no claudeSession link", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { commentOnHandoff: true } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger, {
      worker: {
        id: "worker-1",
        startedAt: "now",
        metadata: { outputs: {} },
      },
    });

    await source.report({ type: "succeeded", sourceId: "linear", run, occurredAt: "now" });

    const commentCall = calls.find((c) => c.name === "save_comment" && c.args.body?.toString().includes("Ready for review"));
    expect(commentCall).toBeUndefined();
  });

  it("truncates lastResult to 4000 characters in the review brief", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const longResult = "x".repeat(5000);
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { commentOnHandoff: true } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger, {
      worker: {
        id: "worker-1",
        startedAt: "now",
        metadata: {
          outputs: {
            claudeSession: {
              link: "https://claude.ai/artifact/jkl012",
              lastResult: longResult,
            },
          },
        },
      },
    });

    await source.report({ type: "succeeded", sourceId: "linear", run, occurredAt: "now" });

    const commentCall = calls.find((c) => c.name === "save_comment");
    const body = commentCall?.args.body as string;
    expect(body).toContain("## Review brief");
    // Extract the brief section
    const briefMatch = body.match(/## Review brief\n\n(.+)$/s);
    expect(briefMatch?.[1]).toBeDefined();
    expect((briefMatch?.[1] ?? "").length).toBeLessThanOrEqual(4000);
  });

  it("moves issue to doneState on succeeded event", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: [] } };
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { doneState: "In Review" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger);

    await source.report({ type: "succeeded", sourceId: "linear", run, occurredAt: "now" });

    const stateCall = calls.find((c) => c.name === "save_issue" && c.args.state === "In Review");
    expect(stateCall).toBeDefined();
    expect(stateCall?.args.id).toBe("uuid-123");
  });

  it("does not move issue to doneState on failed event", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: [] } };
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { doneState: "In Review" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger);

    await source.report({ type: "failed", sourceId: "linear", run, occurredAt: "now" });

    const stateCall = calls.find((c) => c.name === "save_issue" && c.args.state === "In Review");
    expect(stateCall).toBeUndefined();
  });

  it("does not post handoff comment without lastResult", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { commentOnHandoff: true } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger, {
      worker: {
        id: "worker-1",
        startedAt: "now",
        metadata: {
          outputs: {
            claudeSession: {
              link: "https://claude.ai/artifact/mno345",
            },
          },
        },
      },
    });

    await source.report({ type: "succeeded", sourceId: "linear", run, occurredAt: "now" });

    const commentCall = calls.find((c) => c.name === "save_comment");
    expect(commentCall).toBeDefined();
    expect(commentCall?.args.body).not.toContain("## Review brief");
  });
});

describe("Linear label lifecycle", () => {
  it("creates a missing running label before applying it, and caches the check", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        if (name === "list_issue_labels") return { structuredContent: { labels: [] } };
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: [] } };
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { runningLabel: "relay:running" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger);

    await source.report({ type: "claimed", sourceId: "linear", run, occurredAt: "now" });

    const createCall = calls.find((c) => c.name === "create_issue_label");
    expect(createCall).toBeDefined();
    expect(createCall?.args.name).toBe("relay:running");
    const saveCall = calls.find((c) => c.name === "save_issue");
    expect((saveCall?.args.labels as string[])).toContain("relay:running");

    // A second lifecycle event for the same label should not re-check or re-create it.
    calls.length = 0;
    await source.report({ type: "claimed", sourceId: "linear", run, occurredAt: "now" });
    expect(calls.some((c) => c.name === "list_issue_labels")).toBe(false);
    expect(calls.some((c) => c.name === "create_issue_label")).toBe(false);
  });

  it("does not create a missing label when createMissingLabels is false, and warns once", async () => {
    const client: McpToolClient = {
      async callTool(name): Promise<McpToolResult> {
        if (name === "list_issue_labels") return { structuredContent: { labels: [] } };
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: [] } };
        if (name === "create_issue_label") throw new Error("create_issue_label should not be called");
        return { structuredContent: {} };
      },
    };
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = { debug() {}, info() {}, warn: (message: string, context?: Record<string, unknown>) => warnings.push({ message, context }), error() {} };
    const source = new LinearMcpSource({ id: "linear", client, logger, reporting: { runningLabel: "relay:running", createMissingLabels: false } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger);

    await source.report({ type: "claimed", sourceId: "linear", run, occurredAt: "now" });
    await source.report({ type: "claimed", sourceId: "linear", run, occurredAt: "now" });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("relay:running");
  });

  it("does not apply an existing label a second time (label already known to Linear)", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        if (name === "list_issue_labels") return { structuredContent: { labels: [{ name: "relay:done" }] } };
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: [] } };
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { doneLabel: "relay:done" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger);

    await source.report({ type: "succeeded", sourceId: "linear", run, occurredAt: "now" });

    expect(calls.some((c) => c.name === "create_issue_label")).toBe(false);
    const saveCall = calls.find((c) => c.name === "save_issue");
    expect((saveCall?.args.labels as string[])).toContain("relay:done");
  });

  it("logs a warning when save_issue reports an MCP error instead of failing silently", async () => {
    const client: McpToolClient = {
      async callTool(name): Promise<McpToolResult> {
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: [] } };
        if (name === "save_issue") return { isError: true, content: [{ type: "text", text: "permission denied" }] };
        return { structuredContent: {} };
      },
    };
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = { debug() {}, info() {}, warn: (message: string, context?: Record<string, unknown>) => warnings.push({ message, context }), error() {} };
    const source = new LinearMcpSource({ id: "linear", client, logger, reporting: { doneState: "In Review" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger);

    await source.report({ type: "succeeded", sourceId: "linear", run, occurredAt: "now" });

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((warning) => warning.message.includes("Linear"))).toBe(true);
  });

  it("finds a label that exists only in the issue's team using team filter", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        if (name === "list_issue_labels") {
          // When called with team filter and name, return the label
          if (args.team === "team-crm" && args.name === "relay:running") {
            return { structuredContent: { labels: [{ name: "relay:running" }] } };
          }
          // When called without team filter, return empty list
          return { structuredContent: { labels: [] } };
        }
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: [], teamId: "team-crm" } };
        return { structuredContent: {} };
      },
    };
    const source = new LinearMcpSource({ id: "linear", client, reporting: { runningLabel: "relay:running" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger);

    await source.report({ type: "claimed", sourceId: "linear", run, occurredAt: "now" });

    // Should query with team filter first
    const teamFilteredCall = calls.find((c) => c.name === "list_issue_labels" && c.args.team === "team-crm" && c.args.name === "relay:running");
    expect(teamFilteredCall).toBeDefined();

    // Should not try to create the label since it was found
    expect(calls.some((c) => c.name === "create_issue_label")).toBe(false);

    // Should apply the label
    const saveCall = calls.find((c) => c.name === "save_issue");
    expect((saveCall?.args.labels as string[])).toContain("relay:running");
  });

  it("treats label creation error with 'already exists' message as success", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: McpToolClient = {
      async callTool(name, args): Promise<McpToolResult> {
        calls.push({ name, args });
        if (name === "list_issue_labels") return { structuredContent: { labels: [] } };
        if (name === "get_issue") return { structuredContent: { id: "uuid-123", labels: [], teamId: "team-crm" } };
        if (name === "create_issue_label") {
          // Simulate the error: label already exists in team CRM
          return {
            isError: true,
            content: [{ type: "text", text: 'Label "relay:running" already exists in team CRM' }],
          };
        }
        return { structuredContent: {} };
      },
    };
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = { debug() {}, info() {}, warn: (message: string, context?: Record<string, unknown>) => warnings.push({ message, context }), error() {} };
    const source = new LinearMcpSource({ id: "linear", client, logger, reporting: { runningLabel: "relay:running" } });
    const trigger = linearTrigger();
    const item = { sourceId: "linear", id: "ENG-123", title: "Test task", metadata: { linearIssueId: "uuid-123" } };
    const run = runFor(item, trigger);

    await source.report({ type: "claimed", sourceId: "linear", run, occurredAt: "now" });

    // Should attempt to create the label
    const createCall = calls.find((c) => c.name === "create_issue_label");
    expect(createCall).toBeDefined();

    // Should not warn (treated as success)
    expect(warnings.length).toBe(0);

    // Should apply the label
    const saveCall = calls.find((c) => c.name === "save_issue");
    expect((saveCall?.args.labels as string[])).toContain("relay:running");
  });
});

function linearTrigger(): TriggerDefinition {
  return { id: "linear-ready", sourceId: "linear", repository: { id: "repo", root: "/repo" }, enabled: true };
}

function runFor(item: RunRecord["item"], trigger: TriggerDefinition, overrides?: Partial<RunRecord>): RunRecord {
  return {
    id: "run",
    identity: { repository: trigger.repository, sourceId: "linear", itemId: item.id, triggerId: trigger.id },
    item,
    trigger,
    agent: { agentId: "codex" },
    status: "claimed",
    claimedAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}
