import { z } from "zod";
import type { ActionPlugin } from "@task-relay/plugin-sdk";

export const claudeOpenInAppConfigSchema = z.object({
  /** This deliberately accepts only a producing action, never a loose worker selector. */
  session: z.object({ action: z.string().min(1) }).strict(),
  force: z.boolean().optional(),
}).strict();

export type ClaudeOpenInAppActionConfig = z.infer<typeof claudeOpenInAppConfigSchema>;

export interface ClaudeOpenInAppDependencies {}
export function createClaudeOpenInAppAction(_options: ClaudeOpenInAppDependencies = {}): ActionPlugin<ClaudeOpenInAppActionConfig> {
  return {
    kind: "action",
    use: "claude.open-in-app",
    configSchema: claudeOpenInAppConfigSchema,
    presentation: {
      name: "Open in Claude app",
      description: "Hand a headless Claude Code session off to the desktop app for human review.",
      category: "Claude",
      icon: "external-link",
      color: "#d97757",
    },
    execute: async (context, config) => {
      const result = await context.workers.handoff(config.session, { target: "claude-app", ...(config.force !== undefined ? { force: config.force } : {}) });
      return { status: "succeeded", output: { ...result } };
    },
  };
}
