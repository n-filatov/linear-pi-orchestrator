import Handlebars from "handlebars";
import { z } from "zod";
import type { ActionContext, ExplicitActionOutcome, VersionedActionPlugin } from "@task-relay/plugin-sdk";

export const claudeSendPromptInputSchema = z.object({
  /** This deliberately accepts only a producing action, never a loose worker selector. */
  session: z.object({ action: z.string().min(1) }).strict(),
  prompt: z.string().min(1).optional().describe("Inline prompt. Use promptFile for a saved prompt."),
  promptFile: z.string().min(1).optional().describe("Saved prompt under .task-relay/prompts/ (alternative to inline prompt)."),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  jsonSchema: z.record(z.unknown()).optional(),
}).strict().refine((data) => Boolean(data.prompt) !== Boolean(data.promptFile), { message: "Specify exactly one of 'prompt' or 'promptFile'." });

export type ClaudeSendPromptInput = z.infer<typeof claudeSendPromptInputSchema>;

export const claudeSendPromptOutputSchema = z.object({
  turnId: z.string().min(1),
  result: z.string().optional(),
  structuredOutput: z.unknown().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
}).strict();

export type ClaudeSendPromptOutput = z.infer<typeof claudeSendPromptOutputSchema>;

function renderer(context: ActionContext): (value: string) => string {
  const values = actionTemplateValues(context);
  // Prompts are templates by contract: the host resolves `${{ }}` in config, but
  // `{{item.id}}` in a prompt (inline or file) is always rendered here.
  return (value: string) => Handlebars.compile(value, { noEscape: true })(values);
}

function actionTemplateValues(context: ActionContext): Record<string, unknown> {
  return { item: context.item, actions: context.outputs, repository: context.repository };
}

interface PromptOperation { workerId: string; turnId: string; }

function parseOperation(operation: Record<string, unknown>): PromptOperation {
  const { workerId, turnId } = operation;
  if (typeof workerId !== "string" || !workerId || typeof turnId !== "string" || !turnId) {
    throw new Error("A claude.send-prompt operation must carry a workerId and turnId.");
  }
  return { workerId, turnId };
}

export interface ClaudeSendPromptDependencies { readPromptFile(root: string, file: string): Promise<string>; }
export function createClaudeSendPromptAction(options: ClaudeSendPromptDependencies): VersionedActionPlugin<ClaudeSendPromptInput, ClaudeSendPromptOutput> {
  return {
    kind: "action",
    use: "claude.send-prompt",
    apiVersion: 1,
    configSchema: claudeSendPromptInputSchema,
    inputSchema: claudeSendPromptInputSchema,
    outputSchema: claudeSendPromptOutputSchema,
    presentation: {
      name: "Send prompt to Claude session",
      description: "Start a turn on a running headless Claude Code session.",
      category: "Claude",
      icon: "send",
      color: "#d97757",
    },
    execute: async (context, input): Promise<ExplicitActionOutcome<ClaudeSendPromptOutput>> => {
      const render = renderer(context);
      const promptText = render(input.prompt ?? await options.readPromptFile(context.repository.root, input.promptFile!));
      const model = input.model ? render(input.model) : undefined;
      const effort = input.effort ? render(input.effort) : undefined;
      const turn = await context.workers.prompt(input.session, {
        prompt: promptText,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
      });
      return { status: "running", operation: { workerId: turn.workerId, turnId: turn.turnId } };
    },
    reconcile: async (context, operation): Promise<ExplicitActionOutcome<ClaudeSendPromptOutput>> => {
      const { workerId, turnId } = parseOperation(operation);
      const turn = await context.workers.turn({ workerId }, turnId);
      if (turn.status === "running") return { status: "running", operation: { workerId, turnId } };
      if (turn.status === "succeeded") {
        return {
          status: "succeeded",
          output: {
            turnId: turn.turnId,
            ...(turn.result !== undefined ? { result: turn.result } : {}),
            ...(turn.structuredOutput !== undefined ? { structuredOutput: turn.structuredOutput } : {}),
            ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
            ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
          },
        };
      }
      return { status: "failed", error: turn.error ?? "The Claude turn failed.", output: { turnId: turn.turnId } };
    },
    cancel: async (context, operation): Promise<ExplicitActionOutcome<ClaudeSendPromptOutput>> => {
      const { workerId } = parseOperation(operation);
      await context.workers.stop({ workerId });
      // The engine accepts only a terminal non-failure as a verified cancel.
      return { status: "skipped", message: "Cancelled." };
    },
  };
}
