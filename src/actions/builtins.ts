import path from "node:path";
import { readFile } from "node:fs/promises";
import { execa } from "execa";
import Handlebars from "handlebars";
import { z } from "zod";
import { isActiveRun } from "../domain/index.js";
import type { ActionContext, ActionPlugin } from "../plugins/index.js";

const launchConfigSchema = z.object({
  harness: z.string().min(1),
  mode: z.enum(["oneshot", "interactive"]).default("oneshot"),
  model: z.string().min(1).optional(),
  modelProfile: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
  workspace: z.object({
    /** Reuse the branch and worktree of a worker an earlier action created. */
    fromAction: z.string().min(1).optional(),
    branchTemplate: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
  }).strict().optional(),
}).strict().refine(
  (data) => !(data.prompt && data.promptFile),
  { message: "Specify either 'prompt' or 'promptFile', not both." },
);

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

/**
 * How a worker-scoped action names its target. The default addresses the most
 * recent worker for the item this trigger matched, which is what a single-step
 * "talk to the agent working on this ticket" workflow means.
 */
const workerRefSchema = z.union([
  z.object({ action: z.string().min(1) }).strict(),
  z.object({ workerId: z.string().min(1) }).strict(),
  z.object({ sourceItem: z.literal("current"), runs: z.enum(["latest", "active", "all"]).default("latest") }).strict(),
]).default({ sourceItem: "current", runs: "latest" });

const workerExecConfigSchema = z.object({
  worker: workerRefSchema,
  /** `pane` splits the worker's own window; `window` opens a separate one. */
  open: z.enum(["pane", "window"]).default("pane"),
  direction: z.enum(["horizontal", "vertical"]).default("vertical"),
  name: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Relative to the worker's workspace, not the repository. */
  cwd: z.string().min(1).optional(),
  environment: z.record(z.string(), z.string()).default({}),
}).strict();

const workerSendConfigSchema = z.object({
  worker: workerRefSchema,
  text: z.string().min(1),
  /** Press Enter after pasting. Turn off to stage text without running it. */
  submit: z.boolean().default(true),
  /** Address a child pane opened by an earlier worker-exec action. */
  child: z.string().min(1).optional(),
}).strict();

export type LaunchActionConfig = z.infer<typeof launchConfigSchema>;
export type CleanupActionConfig = z.infer<typeof cleanupConfigSchema>;
export type WorkerExecActionConfig = z.infer<typeof workerExecConfigSchema>;
export type WorkerSendActionConfig = z.infer<typeof workerSendConfigSchema>;

/** The only template context worker-scoped actions expose. */
function actionTemplateValues(context: ActionContext): Record<string, unknown> {
  return {
    item: context.item,
    worker: context.worker,
    run: context.run,
    actions: context.outputs,
    repository: context.repository,
  };
}

function renderer(context: ActionContext): (value: string) => string {
  const values = actionTemplateValues(context);
  return (value: string) => Handlebars.compile(value, { noEscape: true })(values);
}

export function builtInActionPlugins(): readonly ActionPlugin[] {
  const launch: ActionPlugin<LaunchActionConfig> = {
    kind: "action",
    use: "launch",
    configSchema: launchConfigSchema,
    execute: async (context, config) => {
      let prompt = config.prompt;
      if (config.promptFile) {
        const filePath = path.isAbsolute(config.promptFile)
          ? config.promptFile
          : path.resolve(context.repository.root, config.promptFile);
        prompt = await readFile(filePath, "utf8");
      }
      return context.workers.launch({
        harness: config.harness,
        mode: config.mode,
        model: config.model,
        modelProfile: config.modelProfile,
        prompt,
        workspace: config.workspace,
      });
    },
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
  const workerExec: ActionPlugin<WorkerExecActionConfig> = {
    kind: "action",
    use: "worker-exec",
    configSchema: workerExecConfigSchema,
    execute: async (context, config) => {
      const render = renderer(context);
      return context.workers.exec(config.worker, {
        command: render(config.command),
        args: config.args.map(render),
        cwd: config.cwd ? render(config.cwd) : undefined,
        env: Object.fromEntries(Object.entries(config.environment).map(([key, value]) => [key, render(value)])),
        name: config.name ? render(config.name) : undefined,
        open: config.open,
        direction: config.direction,
      });
    },
  };
  const workerSend: ActionPlugin<WorkerSendActionConfig> = {
    kind: "action",
    use: "worker-send",
    configSchema: workerSendConfigSchema,
    execute: async (context, config) => {
      const render = renderer(context);
      return context.workers.send(config.worker, {
        text: render(config.text),
        submit: config.submit,
        child: config.child ? render(config.child) : undefined,
      });
    },
  };
  const command: ActionPlugin<z.infer<typeof commandConfigSchema>> = {
    kind: "action",
    use: "command",
    configSchema: commandConfigSchema,
    execute: async (context, config) => {
      const render = renderer(context);
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
  return [launch, cleanup, command, workerExec, workerSend];
}
