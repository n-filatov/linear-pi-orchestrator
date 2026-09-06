import Handlebars from "handlebars";
import { z } from "zod";
import type { ActionContext, ActionPlugin } from "@task-relay/plugin-sdk";

/** Small injected seam; the action does not own an App Server implementation. */
export interface CodexPromptClient {
  sendPrompt(worker: NonNullable<ActionContext["worker"]>, options: {
    prompt: string; model?: string; effort?: string; delivery: "idle" | "immediate"; waitForCompletion?: boolean; timeoutMs: number;
  }): Promise<{ threadId: string; turnId: string; delivery: "idle" | "immediate"; turnStatus?: string }>;
}

export const codexSendPromptConfigSchema = z.object({
  /** This deliberately accepts only a producing action, never a loose worker selector. */
  codex: z.object({ action: z.string().min(1) }).strict(),
  prompt: z.string().min(1).optional().describe("Inline prompt. Use promptFile for a saved prompt."),
  promptFile: z.string().min(1).optional().describe("Saved prompt under .task-relay/prompts/ (alternative to inline prompt)."),
  /** Model used for this new turn; the session retains its conversation context. */
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  delivery: z.enum(["idle", "immediate"]).default("idle"),
  /** Keep the workflow job running until Codex finishes the resulting turn. */
  waitForCompletion: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(86_400_000).default(300_000),
}).strict().refine((data) => Boolean(data.prompt) !== Boolean(data.promptFile), { message: "Specify exactly one of 'prompt' or 'promptFile'." });

function renderer(context: ActionContext): (value: string) => string {
  const values = actionTemplateValues(context);
  return (value: string) => context.inputsResolved ? value : Handlebars.compile(value, { noEscape: true })(values);
}


function actionTemplateValues(context: ActionContext): Record<string, unknown> {
  return {
    item: context.item,
    worker: context.worker,
    run: context.run,
    actions: context.outputs,
    repository: context.repository,
  };
}

export interface CodexSendPromptDependencies { codexAppServer?: CodexPromptClient; readPromptFile(root: string, file: string): Promise<string>; }
export function createCodexSendPromptAction(options: CodexSendPromptDependencies): ActionPlugin<CodexSendPromptActionConfig> {
 return {
    kind: "action",
    use: "codex.send-prompt",
    configSchema: codexSendPromptConfigSchema,
    presentation: {
      name: "Send prompt to started Codex",
      description: "Start an idle Codex turn or steer the current one immediately.",
      category: "Workers",
      icon: "send",
      color: "#10a37f",
    },
    execute: async (context, config) => {
      if (!options.codexAppServer) throw new Error("Codex App Server actions were not composed into this Relay runtime.");
      const render = renderer(context);
      const model = config.model ? render(config.model) : undefined;
      const effort = config.effort ? render(config.effort) : undefined;
      if (config.delivery === "immediate" && (model || effort)) {
        throw new Error("A per-prompt model or effort requires delivery: idle, because an active Codex turn cannot change models.");
      }
      const targets = await context.workers.resolve(config.codex);
      if (targets.length === 0) return { status: "skipped", message: `Action '${config.codex.action}' has no live worker.` };
      const prompts = await Promise.all(targets.map(async ({ worker }) => {
        const sent = await options.codexAppServer!.sendPrompt(worker, {
          prompt: render(config.prompt ?? await options.readPromptFile(context.repository.root, config.promptFile!)),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          delivery: config.delivery,
          waitForCompletion: config.waitForCompletion,
          timeoutMs: config.timeoutMs,
        });
        return { workerId: worker.id, ...sent };
      }));
      await context.workers.recordOutputs(config.codex, { codexAppServer: prompts });
      return {
        status: "succeeded",
        output: {
          workerIds: prompts.map((entry) => entry.workerId),
          threadId: prompts.length === 1 ? prompts[0]!.threadId : undefined,
          turnId: prompts.length === 1 ? prompts[0]!.turnId : undefined,
          delivery: config.delivery,
          prompts,
        },
      };
    },
  };
}

export type CodexSendPromptActionConfig = z.infer<typeof codexSendPromptConfigSchema>;
