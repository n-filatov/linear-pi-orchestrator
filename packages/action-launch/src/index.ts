import { z } from "zod";
import type { ActionPlugin } from "@task-relay/plugin-sdk";

export const launchConfigSchema = z.object({
  harness: z.string().min(1), mode: z.enum(["oneshot", "interactive"]).default("oneshot"), model: z.string().min(1).optional(),
  modelProfile: z.string().min(1).optional(), prompt: z.string().min(1).optional(), promptFile: z.string().min(1).optional(),
  workspace: z.object({ fromAction: z.string().min(1).optional(), branchTemplate: z.string().min(1).optional(), baseBranch: z.string().min(1).optional() }).strict().optional(),
}).strict().refine((data) => !(data.prompt && data.promptFile), { message: "Specify either 'prompt' or 'promptFile', not both." });
export type LaunchActionConfig = z.infer<typeof launchConfigSchema>;
export interface LaunchActionDependencies { readPromptFile(root: string, file: string): Promise<string>; }

export function createLaunchAction(dependencies: LaunchActionDependencies): ActionPlugin<LaunchActionConfig> {
  return {
    kind: "action", use: "launch", configSchema: launchConfigSchema,
    presentation: { name: "Launch worker", description: "Start a coding worker through a configured harness.", category: "Workers", icon: "play", color: "#2563eb" },
    async execute(context, config) {
      const prompt = config.promptFile ? await dependencies.readPromptFile(context.repository.root, config.promptFile) : config.prompt;
      return context.workers.launch({ harness: config.harness, mode: config.mode, model: config.model, modelProfile: config.modelProfile, prompt, workspace: config.workspace });
    },
  };
}

export default createLaunchAction;
