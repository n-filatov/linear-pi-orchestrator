import { describe, expect, it, vi } from "vitest";
import { claudeStartSessionConfigSchema, createClaudeStartSessionAction, normalizeSessionName, sanitizeWorktreeName } from "../src/index.js";
import type { ActionContext } from "@task-relay/plugin-sdk";

describe("Claude start-session action", () => {
  it("defaults permissionMode to auto", () => {
    expect(claudeStartSessionConfigSchema.parse({})).toMatchObject({ permissionMode: "auto" });
  });

  it("sanitizes worktree names and caps them at 64 characters", () => {
    expect(sanitizeWorktreeName("PI-123: fix bug/thing!")).toBe("PI-123-fix-bug-thing-");
    expect(sanitizeWorktreeName("a".repeat(100))).toHaveLength(64);
  });

  it("collapses whitespace and caps session names at 100 characters", () => {
    expect(normalizeSessionName("  PI-123   fix   the   bug  ")).toBe("PI-123 fix the bug");
    expect(normalizeSessionName("x".repeat(200))).toHaveLength(100);
  });

  it("launches with workspaceMode project and rendered harnessInput", async () => {
    const launch = vi.fn(async (_input: unknown) => ({ status: "succeeded", output: { workerId: "w1" } }));
    const context = {
      item: { id: "PI-123", title: "Fix the bug: now!" },
      outputs: {},
      repository: { root: "/tmp/repo" },
      inputsResolved: false,
      workers: { launch },
    } as unknown as ActionContext;
    const action = createClaudeStartSessionAction({ harnessId: "__claude_session" });
    const config = claudeStartSessionConfigSchema.parse({ model: "opus", effort: "high", allowedTools: ["mcp__linear__*", "Bash(pnpm *)"] });
    const result = await action.execute(context, config);
    expect(result).toMatchObject({ status: "succeeded" });
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      harness: "__claude_session",
      prompt: "",
      workspaceMode: "project",
      harnessInput: {
        worktree: "PI-123",
        name: "PI-123 Fix the bug: now!",
        permissionMode: "auto",
        model: "opus",
        effort: "high",
        allowedTools: ["mcp__linear__*", "Bash(pnpm *)"],
      },
    });
  });

  it("renders custom worktree and name templates from the item", async () => {
    const launch = vi.fn(async (_input: unknown) => ({ status: "succeeded", output: {} }));
    const context = {
      item: { id: "PI-9", title: "Ship it" },
      outputs: {},
      repository: { root: "/tmp/repo" },
      inputsResolved: false,
      workers: { launch },
    } as unknown as ActionContext;
    const action = createClaudeStartSessionAction({ harnessId: "__claude_session" });
    const config = claudeStartSessionConfigSchema.parse({ worktree: "custom-{{item.id}}", name: "{{item.title}}" });
    await action.execute(context, config);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ harnessInput: { worktree: "custom-PI-9", name: "Ship it" } });
  });
});
