import path from "node:path";
import { execa } from "execa";
import Handlebars from "handlebars";
import { z } from "zod";
import { isActiveRun } from "../domain/index.js";
import type { ActionPlugin } from "../plugins/index.js";

const launchConfigSchema = z.object({
  harness: z.string().min(1),
  mode: z.enum(["oneshot", "interactive"]).default("oneshot"),
  model: z.string().min(1).optional(),
  modelProfile: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
  workspace: z.record(z.string(), z.unknown()).optional(),
}).strict();

const cleanupConfigSchema = z.object({
  activeWorker: z.enum(["stop", "skip"]).default("stop"),
}).strict().default({});

const commandConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  environment: z.record(z.string(), z.string()).default({}),
  stdin: z.string().optional(),
}).strict();

export type LaunchActionConfig = z.infer<typeof launchConfigSchema>;
export type CleanupActionConfig = z.infer<typeof cleanupConfigSchema>;

export function builtInActionPlugins(): readonly ActionPlugin[] {
  const launch: ActionPlugin<LaunchActionConfig> = {
    kind: "action",
    use: "launch",
    configSchema: launchConfigSchema,
    execute: (context, config) => context.workers.launch(config),
  };
  const cleanup: ActionPlugin<CleanupActionConfig> = {
    kind: "action",
    use: "cleanup",
    target: "worker",
    configSchema: cleanupConfigSchema,
    execute: async (context, config) => {
      if (!context.worker || !context.run) return { status: "skipped", message: "No worker was selected." };
      if (config.activeWorker === "skip" && isActiveRun(context.run.status)) {
        return { status: "skipped", message: `Worker ${context.worker.id} is still active.` };
      }
      return context.workers.cleanup(context.worker.id);
    },
  };
  const command: ActionPlugin<z.infer<typeof commandConfigSchema>> = {
    kind: "action",
    use: "command",
    configSchema: commandConfigSchema,
    execute: async (context, config) => {
      const values = {
        item: context.item,
        worker: context.worker,
        run: context.run,
        actions: context.outputs,
        repository: context.repository,
      };
      const render = (value: string) => Handlebars.compile(value, { noEscape: true })(values);
      const cwd = path.resolve(context.repository.root, render(config.cwd ?? "."));
      const completed = await execa(render(config.command), config.args.map(render), {
        cwd,
        env: Object.fromEntries(Object.entries(config.environment).map(([key, value]) => [key, render(value)])),
        input: config.stdin === undefined ? undefined : render(config.stdin),
        reject: false,
      });
      if (completed.exitCode !== 0) throw new Error(`Command action exited with code ${completed.exitCode}: ${completed.stderr.trim()}`);
      return { status: "succeeded", output: { stdout: completed.stdout, exitCode: completed.exitCode } };
    },
  };
  return [launch, cleanup, command];
}
