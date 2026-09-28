import { describe, expect, it } from "vitest";
import { templateFor, setPromptInput } from "../src/dashboard/client/workflow-templates.js";
import { workflowSchema } from "../src/config/v2.js";
import { codexStartSessionConfigSchema } from "../packages/action-codex-start-session/src/index.js";
import { codexSendPromptConfigSchema } from "../packages/action-codex-send-prompt/src/index.js";
import { tmuxCreateWindowConfigSchema } from "../packages/action-tmux-create-window/src/index.js";
import { cleanupConfigSchema } from "../packages/action-cleanup/src/index.js";
import { claudeStartSessionConfigSchema } from "../packages/action-claude-start-session/src/index.js";
import { claudeSendPromptInputSchema } from "../packages/action-claude-send-prompt/src/index.js";
import { claudeOpenInAppConfigSchema } from "../packages/action-claude-open-in-app/src/index.js";

describe("dashboard workflow templates use real plugin contracts", () => {
  const config = { sources: { issues: { use: "linear" } } };
  it("creates an agent task whose workflow and all action inputs are valid", () => {
    const { id, source, ...definition } = templateFor("agent", "delivery", config)!;
    const parsed = workflowSchema.parse(definition);
    const jobs = parsed.jobs!;
    expect(tmuxCreateWindowConfigSchema.safeParse(jobs["tmux-window"].with).success).toBe(true);
    expect(codexStartSessionConfigSchema.safeParse(jobs["codex-session"].with).success).toBe(true);
    expect(codexSendPromptConfigSchema.safeParse(jobs["agent-task"].with).success).toBe(true);
    expect(jobs["agent-task"].needs).toEqual(["codex-session.started"]);
  });

  it("creates an owned-worker cleanup workflow with valid cleanup inputs", () => {
    const { id, source, ...definition } = templateFor("cleanup", "cleanup", config)!;
    const parsed = workflowSchema.parse(definition);
    expect(cleanupConfigSchema.parse(parsed.jobs!.cleanup.with).ownedTmuxOnly).toBe(true);
    expect(parsed.targets?.workers?.sourceItem).toBe("current");
  });

  it("switches between saved and inline prompts without violating exclusivity or losing unrelated fields", () => {
    const saved = setPromptInput({ codex: { action: "session" }, prompt: "Inline", model: "configured-model" }, "promptFile", ".task-relay/prompts/task.md");
    expect(saved).not.toHaveProperty("prompt");
    expect(codexSendPromptConfigSchema.safeParse(saved).success).toBe(true);
    const inline = setPromptInput(saved, "prompt", "Updated task");
    expect(inline).not.toHaveProperty("promptFile");
    expect(inline.model).toBe("configured-model");
    expect(codexSendPromptConfigSchema.safeParse(inline).success).toBe(true);
    expect(codexStartSessionConfigSchema.safeParse(setPromptInput({ tmux: { action: "terminal" }, prompt: "Context" }, "promptFile", ".task-relay/prompts/context.md")).success).toBe(true);
  });

  it("does not invent a source for an unconfigured repository", () => {
    expect(templateFor("agent", "delivery", {})).toBeUndefined();
  });

  it("creates a Claude review chain whose workflow and all action inputs are valid", () => {
    const { id, source, ...definition } = templateFor("claude-review", "review", config)!;
    const parsed = workflowSchema.parse(definition);
    const jobs = parsed.jobs!;
    expect(claudeStartSessionConfigSchema.safeParse(jobs.session.with).success).toBe(true);
    for (const jobId of ["implement", "verify", "self-review", "pull-request", "brief"]) {
      expect(claudeSendPromptInputSchema.safeParse(jobs[jobId]!.with).success).toBe(true);
      expect((jobs[jobId]!.with as { session?: { action?: string } }).session).toEqual({ action: "session" });
    }
    expect(claudeOpenInAppConfigSchema.safeParse(jobs["open-in-app"].with).success).toBe(true);

    // Every prompt job runs on the one persistent session, chained in order.
    expect(jobs.implement.needs).toEqual(["session.started"]);
    expect(jobs.verify.needs).toEqual(["implement.succeeded"]);
    expect(jobs["self-review"].needs).toEqual(["verify.succeeded"]);
    expect(jobs["pull-request"].needs).toEqual(["self-review.succeeded"]);
    expect(jobs.brief.needs).toEqual(["pull-request.succeeded"]);

    // The handoff runs even after a failed review step, but only once the
    // chain has reached the brief.
    expect(jobs["open-in-app"].needs).toEqual(["brief"]);
    expect(jobs["open-in-app"].if).toBe("${{ always() }}");
  });
});
