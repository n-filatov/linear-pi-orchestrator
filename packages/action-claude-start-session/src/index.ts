import Handlebars from "handlebars";
import { z } from "zod";
import type { ActionContext, ActionPlugin } from "@task-relay/plugin-sdk";

export const claudePermissionModeSchema = z.enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);
export type ClaudePermissionMode = z.infer<typeof claudePermissionModeSchema>;

export const claudeStartSessionConfigSchema = z.object({
  /** Worktree name template; rendered then sanitized to `[A-Za-z0-9._-]`, at most 64 characters. */
  worktree: z.string().min(1).optional(),
  /** Session title template; rendered, whitespace-collapsed, then cut to 100 characters. */
  name: z.string().min(1).optional(),
  permissionMode: claudePermissionModeSchema.default("auto"),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
}).strict();

const DEFAULT_WORKTREE_TEMPLATE = "{{item.id}}";
const DEFAULT_NAME_TEMPLATE = "{{item.id}} {{item.title}}";

function renderer(context: ActionContext): (value: string) => string {
  const values = actionTemplateValues(context);
  return (value: string) => context.inputsResolved ? value : Handlebars.compile(value, { noEscape: true })(values);
}

function actionTemplateValues(context: ActionContext): Record<string, unknown> {
  return { item: context.item, actions: context.outputs, repository: context.repository };
}

/** `claude -p --worktree` accepts only these characters in a worktree/branch name. */
export function sanitizeWorktreeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64);
}

/** Collapse whitespace and cap the length of a session title. */
export function normalizeSessionName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 100);
}

export interface ClaudeStartSessionDependencies { harnessId: string; }
export function createClaudeStartSessionAction(options: ClaudeStartSessionDependencies): ActionPlugin<ClaudeStartSessionActionConfig> {
  return {
    kind: "action",
    use: "claude.start-session",
    configSchema: claudeStartSessionConfigSchema,
    presentation: {
      name: "Start Claude session",
      description: "Start a headless Claude Code session on its own worktree.",
      category: "Claude",
      icon: "bot",
      color: "#d97757",
    },
    execute: async (context, config) => {
      const render = renderer(context);
      const worktree = sanitizeWorktreeName(render(config.worktree ?? DEFAULT_WORKTREE_TEMPLATE));
      const name = normalizeSessionName(render(config.name ?? DEFAULT_NAME_TEMPLATE));
      const model = config.model ? render(config.model) : undefined;
      const effort = config.effort ? render(config.effort) : undefined;
      return context.workers.launch({
        harness: options.harnessId,
        prompt: "",
        workspaceMode: "project",
        harnessInput: {
          worktree,
          name,
          permissionMode: config.permissionMode,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        },
      });
    },
  };
}

export type ClaudeStartSessionActionConfig = z.infer<typeof claudeStartSessionConfigSchema>;
