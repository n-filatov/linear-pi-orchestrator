import { describe, expect, it, vi } from "vitest";
import { claudeOpenInAppConfigSchema, createClaudeOpenInAppAction } from "../src/index.js";
import type { ActionContext } from "@task-relay/plugin-sdk";

describe("Claude open-in-app action", () => {
  it("parses a minimal config", () => {
    expect(claudeOpenInAppConfigSchema.parse({ session: { action: "start" } })).toEqual({ session: { action: "start" } });
  });

  it("hands the session off and returns the handoff result as output", async () => {
    const handoff = vi.fn(async (_ref: unknown, _spec: unknown) => ({
      target: "claude-app", handedOffAt: "2026-09-28T00:00:00.000Z", chainStatus: "succeeded" as const,
      link: "claude://claude.ai/epitaxy/local_abc", appSessionId: "local_abc", lastResult: "Reviewed.",
    }));
    const context = { workers: { handoff } } as unknown as ActionContext;
    const action = createClaudeOpenInAppAction();
    const config = claudeOpenInAppConfigSchema.parse({ session: { action: "start" } });
    const result = await action.execute(context, config);
    expect(handoff).toHaveBeenCalledWith({ action: "start" }, { target: "claude-app" });
    expect(result).toEqual({
      status: "succeeded",
      output: {
        target: "claude-app", handedOffAt: "2026-09-28T00:00:00.000Z", chainStatus: "succeeded",
        link: "claude://claude.ai/epitaxy/local_abc", appSessionId: "local_abc", lastResult: "Reviewed.",
      },
    });
  });

  it("passes force through when set", async () => {
    const handoff = vi.fn(async () => ({ target: "claude-app", handedOffAt: "now", chainStatus: "succeeded" as const }));
    const context = { workers: { handoff } } as unknown as ActionContext;
    const action = createClaudeOpenInAppAction();
    const config = claudeOpenInAppConfigSchema.parse({ session: { action: "start" }, force: true });
    await action.execute(context, config);
    expect(handoff).toHaveBeenCalledWith({ action: "start" }, { target: "claude-app", force: true });
  });
});
