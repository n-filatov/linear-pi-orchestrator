import { describe, expect, it, vi } from "vitest";
import { claudeSendPromptInputSchema, createClaudeSendPromptAction } from "../src/index.js";
import type { ActionContext } from "@task-relay/plugin-sdk";

describe("Claude send-prompt action", () => {
  it("requires exactly one of prompt or promptFile", () => {
    expect(() => claudeSendPromptInputSchema.parse({ session: { action: "start" } })).toThrow();
    expect(() => claudeSendPromptInputSchema.parse({ session: { action: "start" }, prompt: "a", promptFile: "a.md" })).toThrow();
    expect(claudeSendPromptInputSchema.parse({ session: { action: "start" }, prompt: "a" }).prompt).toBe("a");
  });

  it("renders the prompt with item/actions/repository and starts a running turn", async () => {
    const prompt = vi.fn(async (_ref: unknown, _spec: unknown) => ({ workerId: "w1", turnId: "t1", status: "running" as const }));
    const readPromptFile = vi.fn(async () => "unused");
    const context = {
      item: { id: "PI-1", title: "Fix" },
      outputs: { start: { status: "succeeded", output: { foo: "bar" } } },
      repository: { root: "/tmp/repo" },
      inputsResolved: false,
      workers: { prompt },
    } as unknown as ActionContext;
    const action = createClaudeSendPromptAction({ readPromptFile });
    const input = claudeSendPromptInputSchema.parse({ session: { action: "start" }, prompt: "Implement {{item.id}} using {{actions.start.output.foo}}" });
    const outcome = await action.execute(context, input);
    expect(outcome).toEqual({ status: "running", operation: { workerId: "w1", turnId: "t1" } });
    expect(prompt.mock.calls[0]?.[0]).toEqual({ action: "start" });
    expect(prompt.mock.calls[0]?.[1]).toMatchObject({ prompt: "Implement PI-1 using bar" });
    expect(readPromptFile).not.toHaveBeenCalled();
  });

  it("reads promptFile when prompt is not inline", async () => {
    const prompt = vi.fn(async (_ref: unknown, _spec: unknown) => ({ workerId: "w1", turnId: "t1", status: "running" as const }));
    const readPromptFile = vi.fn(async (root: string, file: string) => `from ${root}/${file}`);
    const context = {
      item: { id: "PI-1" }, outputs: {}, repository: { root: "/tmp/repo" }, inputsResolved: true,
      workers: { prompt },
    } as unknown as ActionContext;
    const action = createClaudeSendPromptAction({ readPromptFile });
    const input = claudeSendPromptInputSchema.parse({ session: { action: "start" }, promptFile: "verify.md" });
    await action.execute(context, input);
    expect(readPromptFile).toHaveBeenCalledWith("/tmp/repo", "verify.md");
    expect(prompt.mock.calls[0]?.[1]).toMatchObject({ prompt: "from /tmp/repo/verify.md" });
  });

  it("reconciles a running turn through to success", async () => {
    const turn = vi.fn(async () => ({ workerId: "w1", turnId: "t1", status: "running" as const }));
    const context = { workers: { turn } } as unknown as ActionContext;
    const action = createClaudeSendPromptAction({ readPromptFile: async () => "" });
    const outcome = await action.reconcile!(context, { workerId: "w1", turnId: "t1" });
    expect(outcome).toEqual({ status: "running", operation: { workerId: "w1", turnId: "t1" } });
    expect(turn.mock.calls[0]).toEqual([{ workerId: "w1" }, "t1"]);
  });

  it("reconciles a succeeded turn into output", async () => {
    const turn = vi.fn(async () => ({ workerId: "w1", turnId: "t1", status: "succeeded" as const, result: "done", structuredOutput: { ok: true }, costUsd: 0.5, durationMs: 1200 }));
    const context = { workers: { turn } } as unknown as ActionContext;
    const action = createClaudeSendPromptAction({ readPromptFile: async () => "" });
    const outcome = await action.reconcile!(context, { workerId: "w1", turnId: "t1" });
    expect(outcome).toEqual({
      status: "succeeded",
      output: { turnId: "t1", result: "done", structuredOutput: { ok: true }, costUsd: 0.5, durationMs: 1200 },
    });
  });

  it("reconciles a failed turn into a failed outcome", async () => {
    const turn = vi.fn(async () => ({ workerId: "w1", turnId: "t1", status: "failed" as const, error: "boom" }));
    const context = { workers: { turn } } as unknown as ActionContext;
    const action = createClaudeSendPromptAction({ readPromptFile: async () => "" });
    const outcome = await action.reconcile!(context, { workerId: "w1", turnId: "t1" });
    expect(outcome).toEqual({ status: "failed", error: "boom", output: { turnId: "t1" } });
  });

  it("cancels by stopping the worker and reporting cancellation", async () => {
    const stop = vi.fn(async () => ({ status: "succeeded" as const }));
    const context = { workers: { stop } } as unknown as ActionContext;
    const action = createClaudeSendPromptAction({ readPromptFile: async () => "" });
    const outcome = await action.cancel!(context, { workerId: "w1", turnId: "t1" });
    expect(outcome).toEqual({ status: "skipped", message: "Cancelled." });
    expect(stop).toHaveBeenCalledWith({ workerId: "w1" });
  });
});
