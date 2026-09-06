import Handlebars from "handlebars";
import { z } from "zod";
import type { ActionContext, ActionPlugin } from "@task-relay/plugin-sdk";

export const codexStartSessionConfigSchema = z.object({
  prompt: z.string().min(1).optional().describe("Inline prompt. Use promptFile for a saved prompt."),
  promptFile: z.string().min(1).optional().describe("Saved prompt under .task-relay/prompts/ (alternative to inline prompt)."),
  /** Attach a visible Codex TUI to the tmux worker produced by this action. */
  tmux: z.object({
    action: z.string().min(1),
  }).strict().optional(),
  workspace: z.object({
    fromAction: z.string().min(1).optional(),
    branchTemplate: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
  }).strict().optional(),
}).strip().refine((data) => Boolean(data.prompt) !== Boolean(data.promptFile), { message: "Specify exactly one of 'prompt' or 'promptFile'." });

function renderer(context: ActionContext): (value: string) => string {
  const values = actionTemplateValues(context);
  return (value: string) => context.inputsResolved ? value : Handlebars.compile(value, { noEscape: true })(values);
}


function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

async function resolveTmuxBinding(context: ActionContext, action: string): Promise<{ action: string; workerId: string; session: string; target: string }> {
  const targets = await context.workers.resolve({ action });
  if (targets.length === 0) {
    throw new Error(`tmux action '${action}' did not produce a live worker. Connect it with a successful tmux.create-window action.`);
  }
  if (targets.length > 1) {
    throw new Error(`tmux action '${action}' resolved to ${targets.length} workers; a Codex session must bind to exactly one tmux.create-window worker.`);
  }
  const worker = targets[0]!.worker;
  const metadata = worker.metadata?.tmux;
  const tmux = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : undefined;
  const session = typeof tmux?.session === "string" ? tmux.session : undefined;
  const target = typeof tmux?.target === "string" ? tmux.target : undefined;
  if (!session || !target) {
    throw new Error(`Action '${action}' is not a live tmux.create-window worker (missing tmux session/target metadata).`);
  }
  return { action, workerId: worker.id, session, target };
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

export interface CodexStartSessionDependencies { codexAppServer?: unknown; harnessId: string; readPromptFile(root: string, file: string): Promise<string>; }
export function createCodexStartSessionAction(options: CodexStartSessionDependencies): ActionPlugin<CodexStartSessionActionConfig> {
 return {
    kind: "action",
    use: "codex.start-session",
    configSchema: codexStartSessionConfigSchema,
    presentation: {
      name: "Start Codex in tmux window",
      description: "Start a Codex App Server session and open its TUI in the selected terminal.",
      category: "Workers",
      icon: "bot",
      color: "#10a37f",
    },
    execute: async (context, config) => {
      if (!options.codexAppServer) throw new Error("Codex App Server actions were not composed into this Relay runtime.");
      const render = renderer(context);
      const tmux = config.tmux ? await resolveTmuxBinding(context, config.tmux.action) : undefined;
      const result = await context.workers.launch({
        harness: options.harnessId,
        prompt: render(config.prompt ?? await options.readPromptFile(context.repository.root, config.promptFile!)),
        // The App Server is a background helper. When attached to tmux, it
        // must reuse that terminal worker's worktree and may coexist with it.
        workspace: tmux
          ? { ...(config.workspace && Object.fromEntries(Object.entries(config.workspace).map(([key, value]) => [key, render(value)]))), fromAction: tmux.action }
          : config.workspace && Object.fromEntries(Object.entries(config.workspace).map(([key, value]) => [key, render(value)])),
        ...(tmux ? { sidecar: true } : {}),
        ...(tmux ? { harnessInput: { remoteTui: tmux } } : {}),
      });
      if (!tmux || result.status !== "succeeded") return result;
      const endpoint = result.output?.endpoint;
      if (typeof endpoint !== "string") {
        throw new Error(`Codex App Server did not expose a loopback remote endpoint for tmux action '${tmux.action}'.`);
      }
      // Do not split a pane: this intentionally invokes Codex in the shell
      // pane that tmux.create-window opened. Other nodes can target the same
      // worker via worker-send and invoke any command in that terminal.
      const threadId = result.output?.threadId;
      if (typeof threadId !== "string" || !threadId) {
        throw new Error(`Codex App Server did not expose a thread id for tmux action '${tmux.action}'.`);
      }
      // `codex --remote` opens a *new* CLI thread on the App Server. Resume
      // the Relay-owned thread instead, otherwise automated turns arrive in a
      // different (invisible to tmux) conversation than the user is watching.
      const opened = await context.workers.send({ action: tmux.action }, {
        text: `codex resume ${shellQuote(threadId)} --remote ${shellQuote(endpoint)}`,
        submit: true,
      });
      if (opened.status !== "succeeded") {
        throw new Error(`Could not start the Codex TUI in tmux action '${tmux.action}': ${opened.message ?? "the tmux worker is no longer available"}.`);
      }
      await context.workers.recordOutputs({ action: tmux.action }, {
        codexAppServer: {
          workerId: result.output?.workerId,
          threadId: result.output?.threadId,
          turnId: result.output?.turnId,
          endpoint,
          tmux,
        },
      });
      return {
        ...result,
        output: { ...result.output, endpoint, tmux, terminal: opened.output },
      };
    },
  };
}

export type CodexStartSessionActionConfig = z.infer<typeof codexStartSessionConfigSchema>;
