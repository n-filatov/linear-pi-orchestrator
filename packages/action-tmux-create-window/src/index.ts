import { z } from "zod";
import type { ActionContext, ActionPlugin } from "@task-relay/plugin-sdk";

export const tmuxCreateWindowConfigSchema = z.object({}).strict().default({});

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
      return context.workers.launch({ harness: options.harnessId, prompt: "Open an owned tmux shell window." });
    },
  };
}

export type TmuxCreateWindowActionConfig = z.infer<typeof tmuxCreateWindowConfigSchema>;
