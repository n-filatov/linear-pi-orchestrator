import { execa } from "execa";
import path from "node:path";
import Handlebars from "handlebars";
import { z } from "zod";
import { isActiveRun } from "../domain/index.js";
import type { ActionContext, ActionPlugin } from "../plugins/index.js";
import { CODEX_APP_SERVER_HARNESS_ID, type CodexAppServerHarness } from "../codex/index.js";
import { TMUX_WINDOW_HARNESS_ID } from "../runtime/index.js";
import { readPromptFile } from "../prompts/library.js";

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
  /**
   * Terminal Linear workflows should only delete a terminal window when its
   * durable Relay tmux identity is present. The tmux adapter verifies that
   * identity against the live window before it kills anything.
   */
  ownedTmuxOnly: z.boolean().default(false),
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

const tmuxCreateWindowConfigSchema = z.object({}).strict().default({});

const codexStartSessionConfigSchema = z.object({
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

const codexSendPromptConfigSchema = z.object({
  /** This deliberately accepts only a producing action, never a loose worker selector. */
  codex: z.object({ action: z.string().min(1) }).strict(),
  prompt: z.string().min(1).optional().describe("Inline prompt. Use promptFile for a saved prompt."),
  promptFile: z.string().min(1).optional().describe("Saved prompt under .task-relay/prompts/ (alternative to inline prompt)."),
  /** Model used for this new turn; the session retains its conversation context. */
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  delivery: z.enum(["idle", "immediate"]).default("idle"),
  /** Keep the workflow job running until Codex finishes the resulting turn. */
  waitForCompletion: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(86_400_000).default(300_000),
}).strict().refine((data) => Boolean(data.prompt) !== Boolean(data.promptFile), { message: "Specify exactly one of 'prompt' or 'promptFile'." });

export type LaunchActionConfig = z.infer<typeof launchConfigSchema>;
export type CleanupActionConfig = z.infer<typeof cleanupConfigSchema>;
export type WorkerExecActionConfig = z.infer<typeof workerExecConfigSchema>;
export type WorkerSendActionConfig = z.infer<typeof workerSendConfigSchema>;
export type TmuxCreateWindowActionConfig = z.infer<typeof tmuxCreateWindowConfigSchema>;
export type CodexStartSessionActionConfig = z.infer<typeof codexStartSessionConfigSchema>;
export type CodexSendPromptActionConfig = z.infer<typeof codexSendPromptConfigSchema>;

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

async function configuredPrompt(context: ActionContext, config: { prompt?: string; promptFile?: string }): Promise<string> {
  return config.prompt ?? readPromptFile(context.repository.root, config.promptFile!);
}

export function builtInActionPlugins(options: { codexAppServer?: CodexAppServerHarness } = {}): readonly ActionPlugin[] {
  const launch: ActionPlugin<LaunchActionConfig> = {
    kind: "action",
    use: "launch",
    configSchema: launchConfigSchema,
    presentation: {
      name: "Launch worker",
      description: "Start a coding worker through a configured harness.",
      category: "Workers",
      icon: "play",
      color: "#2563eb",
    },
    execute: async (context, config) => {
      // A generic launch may deliberately rely on its harness default prompt.
      const prompt = config.promptFile
        ? await readPromptFile(context.repository.root, config.promptFile)
        : config.prompt;
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
  const workerExec: ActionPlugin<WorkerExecActionConfig> = {
    kind: "action",
    use: "worker-exec",
    configSchema: workerExecConfigSchema,
    presentation: {
      name: "Run beside worker",
      description: "Open a command pane or window in a worker workspace.",
      category: "Workers",
      icon: "terminal-square",
      color: "#7c3aed",
    },
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
    presentation: {
      name: "Run command in terminal",
      description: "Send a command or text to the current pane of a selected live terminal worker.",
      category: "Workers",
      icon: "send",
      color: "#0891b2",
    },
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
    presentation: {
      name: "Run command",
      description: "Run a configured command without invoking a shell.",
      category: "Automation",
      icon: "terminal",
      color: "#475569",
    },
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
  const tmuxCreateWindow: ActionPlugin<TmuxCreateWindowActionConfig> = {
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
      return context.workers.launch({ harness: TMUX_WINDOW_HARNESS_ID, prompt: "Open an owned tmux shell window." });
    },
  };
  const codexStartSession: ActionPlugin<CodexStartSessionActionConfig> = {
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
        harness: CODEX_APP_SERVER_HARNESS_ID,
        prompt: render(await configuredPrompt(context, config)),
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
  const codexSendPrompt: ActionPlugin<CodexSendPromptActionConfig> = {
    kind: "action",
    use: "codex.send-prompt",
    configSchema: codexSendPromptConfigSchema,
    presentation: {
      name: "Send prompt to started Codex",
      description: "Start an idle Codex turn or steer the current one immediately.",
      category: "Workers",
      icon: "send",
      color: "#10a37f",
    },
    execute: async (context, config) => {
      if (!options.codexAppServer) throw new Error("Codex App Server actions were not composed into this Relay runtime.");
      const render = renderer(context);
      const model = config.model ? render(config.model) : undefined;
      const effort = config.effort ? render(config.effort) : undefined;
      if (config.delivery === "immediate" && (model || effort)) {
        throw new Error("A per-prompt model or effort requires delivery: idle, because an active Codex turn cannot change models.");
      }
      const targets = await context.workers.resolve(config.codex);
      if (targets.length === 0) return { status: "skipped", message: `Action '${config.codex.action}' has no live worker.` };
      const prompts = await Promise.all(targets.map(async ({ worker }) => {
        const sent = await options.codexAppServer!.sendPrompt(worker, {
          prompt: render(await configuredPrompt(context, config)),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          delivery: config.delivery,
          waitForCompletion: config.waitForCompletion,
          timeoutMs: config.timeoutMs,
        });
        return { workerId: worker.id, ...sent };
      }));
      await context.workers.recordOutputs(config.codex, { codexAppServer: prompts });
      return {
        status: "succeeded",
        output: {
          workerIds: prompts.map((entry) => entry.workerId),
          threadId: prompts.length === 1 ? prompts[0]!.threadId : undefined,
          turnId: prompts.length === 1 ? prompts[0]!.turnId : undefined,
          delivery: config.delivery,
          prompts,
        },
      };
    },
  };
  return [launch, cleanup, command, workerExec, workerSend, tmuxCreateWindow, codexStartSession, codexSendPrompt];
}

/** Quote a generated endpoint as one POSIX shell argument before sending it to tmux. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

/**
 * A saved target/window id is not authority to delete a tmux window: ids are
 * recycled after a tmux restart. New Relay workers carry this generation id;
 * TmuxExecutionAdapter.stop verifies the same tag on the live window.
 */
function hasVerifiedRelayTmuxIdentity(worker: NonNullable<ActionContext["worker"]>): boolean {
  const tmux = worker.metadata?.tmux;
  if (!tmux || typeof tmux !== "object" || Array.isArray(tmux)) return false;
  const metadata = tmux as Record<string, unknown>;
  return metadata.workerId === worker.id
    && typeof metadata.session === "string" && metadata.session.length > 0
    && typeof metadata.target === "string" && metadata.target.length > 0;
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
