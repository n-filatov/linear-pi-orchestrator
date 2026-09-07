import Handlebars from "handlebars";
import { z } from "zod";
import type { ActionContext, ActionPlugin } from "@task-relay/plugin-sdk";

export const tmuxCreateWindowConfigSchema = z.object({
  windowNameTemplate: z.string().trim().min(1).optional().describe("Window name template, e.g. {{item.id}}-{{item.title}}. Defaults to the ticket ID. Names are normalized and shortened to 48 characters."),
}).strict().default({});

export function createTmuxCreateWindowAction(options: { harnessId: string }): ActionPlugin<TmuxCreateWindowActionConfig> {
 return {
    kind: "action",
    use: "tmux.create-window",
    configSchema: tmuxCreateWindowConfigSchema,
    presentation: {
      name: "Start tmux window",
      description: "Create an owned detached login-shell window in the item workspace.",
      category: "Automation",
      icon: "panel-top",
      color: "#7c3aed",
    },
    execute: async (context, config) => {
      const template = config.windowNameTemplate;
      const windowName = template === undefined ? undefined : context.inputsResolved ? template
        : Handlebars.compile(template, { noEscape: true })({ item: context.item, worker: context.worker, run: context.run, actions: context.outputs, repository: context.repository });
      return context.workers.launch({
        harness: options.harnessId, prompt: "Open an owned tmux shell window.",
        ...(windowName === undefined ? {} : { harnessInput: { windowName } }),
      });
    },
  };
}

export type TmuxCreateWindowActionConfig = z.infer<typeof tmuxCreateWindowConfigSchema>;
