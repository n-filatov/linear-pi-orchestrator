import { execa } from "execa";
import path from "node:path";
import Handlebars from "handlebars";
import { z } from "zod";
import type { ActionContext, ActionPlugin } from "@task-relay/plugin-sdk";

export const commandConfigSchema = z.object({
  command: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().min(1).optional(),
  environment: z.record(z.string(), z.string()).default({}), stdin: z.string().optional(),
}).strict();
export type CommandActionConfig = z.infer<typeof commandConfigSchema>;

function render(context: ActionContext, value: string): string {
  if (context.inputsResolved) return value;
  return Handlebars.compile(value, { noEscape: true })({ item: context.item, worker: context.worker, run: context.run, actions: context.outputs, repository: context.repository });
}

/** Factory owns no host runtime state, so it is safe to instantiate per composition root. */
export function createCommandAction(): ActionPlugin<CommandActionConfig> {
  return {
    kind: "action", use: "command", configSchema: commandConfigSchema,
    presentation: { name: "Run command", description: "Run a configured command without invoking a shell.", category: "Automation", icon: "terminal", color: "#475569" },
    async execute(context, config) {
      const cwd = path.resolve(context.repository.root, render(context, config.cwd ?? "."));
      const completed = await execa(render(context, config.command), config.args.map((value) => render(context, value)), {
        cwd, env: Object.fromEntries(Object.entries(config.environment).map(([key, value]) => [key, render(context, value)])),
        input: config.stdin === undefined ? undefined : render(context, config.stdin), reject: false,
        cancelSignal: context.signal,
      });
      if (completed.exitCode !== 0) throw new Error(`Command action exited with code ${completed.exitCode}: ${completed.stderr.trim()}`);
      return { status: "succeeded", output: { stdout: completed.stdout, exitCode: completed.exitCode } };
    },
  };
}

export default createCommandAction;
