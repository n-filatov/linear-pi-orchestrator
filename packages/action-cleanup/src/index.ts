import { z } from "zod";
import { isActiveRun } from "@task-relay/domain";
import type { ActionContext, ActionPlugin } from "@task-relay/plugin-sdk";

export const cleanupConfigSchema = z.object({
  activeWorker: z.enum(["stop", "skip"]).default("stop"),
  /**
   * Terminal Linear workflows should only delete a terminal window when its
   * durable Relay tmux identity is present. The tmux adapter verifies that
   * identity against the live window before it kills anything.
   */
  ownedTmuxOnly: z.boolean().default(false),
}).strict().default({});

function hasVerifiedRelayTmuxIdentity(worker: NonNullable<ActionContext["worker"]>): boolean {
  const tmux = worker.metadata?.tmux;
  if (!tmux || typeof tmux !== "object" || Array.isArray(tmux)) return false;
  const metadata = tmux as Record<string, unknown>;
  return metadata.workerId === worker.id
    && typeof metadata.session === "string" && metadata.session.length > 0
    && typeof metadata.target === "string" && metadata.target.length > 0;
}

export function createCleanupAction(): ActionPlugin<CleanupActionConfig> {
 return {
    kind: "action",
    use: "cleanup",
    target: "worker",
    configSchema: cleanupConfigSchema,
    presentation: {
      name: "Cleanup",
      description: "Stop and clean the Relay-owned workspace and tmux window.",
      category: "Workers",
      icon: "trash-2",
      color: "#dc2626",
    },
    execute: async (context, config) => {
      if (!context.worker || !context.run) return { status: "skipped", message: "No worker was selected." };
      if (config.ownedTmuxOnly && !hasVerifiedRelayTmuxIdentity(context.worker)) {
        return {
          status: "skipped",
          message: `Worker ${context.worker.id} has no verified Relay-owned tmux identity.`,
        };
      }
      if (config.activeWorker === "skip" && isActiveRun(context.run.status)) {
        return { status: "skipped", message: `Worker ${context.worker.id} is still active.` };
      }
      return context.workers.cleanup(context.worker.id);
    },
  };
}

export type CleanupActionConfig = z.infer<typeof cleanupConfigSchema>;
