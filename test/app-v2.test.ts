import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createRuntimeHandlers } from "../src/app.js";
import { createRelayProgram } from "../src/cli/program.js";
import { loadRelayConfig } from "../src/config/load.js";
import { RepositoryStateStore } from "../src/state/store.js";

const originalStateHome = process.env.XDG_STATE_HOME;
const temporaryStateHomes: string[] = [];

afterEach(() => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
});

function captureProgram(root: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: string[] = [];
  const errors: string[] = [];
  stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  return {
    program: createRelayProgram({ handlers: createRuntimeHandlers(), stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, cwd: () => root }),
    output: () => output.join(""),
    errors: () => errors.join(""),
  };
}

async function run(root: string, ...arguments_: string[]): Promise<{ output: string; errors: string }> {
  const captured = captureProgram(root);
  await captured.program.parseAsync(["node", "relay", ...arguments_]);
  return { output: captured.output(), errors: captured.errors() };
}

describe("v2 app/config integration", () => {
  it("discovers a native v2 command source through trigger test and executes a command action once", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-relay-v2-app-"));
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-v2-state-"));
    temporaryStateHomes.push(stateHome);
    process.env.XDG_STATE_HOME = stateHome;
    const sourceProgram = "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'TASK-1',title:'Config action task'}]}))";
    const actionProgram = "process.stdout.write('command action ran')";
    await writeFile(join(root, ".task-relay.yaml"), stringify({
      version: 2,
      project: { name: "v2-app-test" },
      sources: {
        queue: {
          use: "command",
          with: { discover: { command: process.execPath, args: ["-e", sourceProgram] } },
        },
      },
      actions: {
        notify: { use: "command", with: { command: process.execPath, args: ["-e", actionProgram] } },
      },
      triggers: [{ id: "ready", source: "queue", match: { arbitraryProviderField: "preserved" }, actions: ["notify"] }],
      logging: { level: "silent", pretty: false },
    }));

    const preview = await run(root, "trigger", "test", "ready");
    expect(preview.errors).toBe("");
    expect(preview.output).toContain("Trigger: ready");
    expect(preview.output).toContain("Actions: notify (command)");
    expect(preview.output).toContain("TASK-1  Config action task");
    expect(preview.output).toContain("Dry run only");

    const tick = await run(root, "once", "--trigger", "ready");
    expect(tick.errors).toBe("");
    expect(tick.output).toContain("Tick: 1 discovered | 1 actions");
    expect(tick.output).toContain("Ticket");
    expect(tick.output).toContain("Title");
    expect(tick.output).toContain("TASK-1");
    expect(tick.output).toContain("Config action task");
    // App composition resolves the project root through realpath(), which can
    // differ from macOS's `/var` spelling used by mkdtemp(). Use the same
    // normalized root when reading its repository-scoped state.
    const projectRoot = (await loadRelayConfig(root)).projectRoot;
    const executions = await new RepositoryStateStore(projectRoot).listActionExecutions();
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ triggerId: "ready", actionId: "notify", sourceId: "queue", itemId: "TASK-1", status: "succeeded", output: { stdout: "command action ran", exitCode: 0 } });

    const repeated = await run(root, "once", "--trigger", "ready");
    expect(repeated.output).toContain("0 actions");
    expect(await new RepositoryStateStore(projectRoot).listActionExecutions()).toHaveLength(1);
  });

  it("composes a worker pipeline and reports a missing worker as skipped, not failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-relay-worker-app-"));
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-worker-state-"));
    temporaryStateHomes.push(stateHome);
    process.env.XDG_STATE_HOME = stateHome;
    const sourceProgram = "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'TASK-9',title:'Add a dev server'}]}))";
    await writeFile(join(root, ".task-relay.yaml"), stringify({
      version: 2,
      project: { name: "worker-app-test" },
      sources: { queue: { use: "command", with: { discover: { command: process.execPath, args: ["-e", sourceProgram] } } } },
      harnesses: { codex: { use: "codex" } },
      actions: {
        "dev-server": {
          use: "worker-exec",
          with: { worker: { action: "implement" }, open: "pane", name: "dev", command: "npm", args: ["run", "dev"] },
        },
        ask: { use: "worker-send", with: { text: "New guidance on {{item.id}}: {{item.title}}" } },
        review: {
          use: "launch",
          with: { harness: "codex", mode: "interactive", workspace: { fromAction: "implement" }, prompt: "Review {{item.id}}" },
        },
      },
      triggers: [{ id: "ask-worker", source: "queue", actions: ["ask"], fire: { policy: "every-poll" } }],
      execution: { adapter: "tmux", tmuxSession: "task-relay-worker-app-test" },
      logging: { level: "silent", pretty: false },
    }));

    const preview = await run(root, "trigger", "test", "ask-worker");
    expect(preview.errors).toBe("");
    expect(preview.output).toContain("Actions: ask (worker-send)");
    expect(preview.output).toContain("TASK-9  Add a dev server");

    // No worker exists for the item, so the action is a clean skip. Nothing
    // reaches tmux, and the pipeline does not fail.
    const tick = await run(root, "once", "--trigger", "ask-worker");
    expect(tick.errors).toBe("");
    expect(tick.output).toContain("0 action failures");
    expect(tick.output).toContain("No matching worker is running.");
  });

  it("applies launch rules to an external action that wraps workers.launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-relay-external-launch-"));
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-external-state-"));
    temporaryStateHomes.push(stateHome);
    process.env.XDG_STATE_HOME = stateHome;
    // A plugin Relay cannot inspect statically: its `use` is not "launch", so
    // only the request-level check can catch the unknown harness.
    await writeFile(join(root, "wrap-launch.mjs"), [
      "export default {",
      "  kind: 'action',",
      "  use: 'wrap-launch',",
      "  configSchema: { parse: (value) => value ?? {} },",
      "  async execute(context) {",
      "    return context.workers.launch({ harness: 'not-configured', mode: 'oneshot', prompt: 'go' });",
      "  },",
      "};",
    ].join("\n"));
    const sourceProgram = "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'TASK-7',title:'Wrapped launch'}]}))";
    await writeFile(join(root, ".task-relay.yaml"), stringify({
      version: 2,
      project: { name: "external-launch-test" },
      sources: { queue: { use: "command", with: { discover: { command: process.execPath, args: ["-e", sourceProgram] } } } },
      harnesses: { codex: { use: "codex" } },
      actions: { implement: { use: "./wrap-launch.mjs", with: {} } },
      triggers: [{ id: "ready", source: "queue", actions: ["implement"] }],
      logging: { level: "silent", pretty: false },
    }));

    const tick = await run(root, "once", "--trigger", "ready");
    expect(tick.errors).toBe("");
    expect(tick.output).toContain("1 action failures");
    expect(tick.output).toContain("unknown harness 'not-configured'");
    expect(tick.output).toContain("Configured harnesses: codex.");
  });

  it("launches a worker through an external harness plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-relay-harness-plugin-"));
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-harness-state-"));
    temporaryStateHomes.push(stateHome);
    process.env.XDG_STATE_HOME = stateHome;
    const marker = join(root, "harness-launched.json");

    // A harness plugin owns its own process. Relay hands it a rendered prompt
    // and a workspace, and records the WorkerHandle it returns.
    await writeFile(join(root, "harness.mjs"), [
      "import { writeFileSync } from 'node:fs';",
      "export default {",
      "  kind: 'harness',",
      "  use: 'fixture-harness',",
      "  configSchema: { parse: (value) => value ?? {} },",
      "  async launch(request) {",
      `    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
      "      workerId: request.workerId, prompt: request.prompt, model: request.model,",
      "      workspace: request.workspace.path, config: request.config,",
      "    }));",
      "    return { id: request.workerId, startedAt: '2026-08-19T00:00:00.000Z' };",
      "  },",
      "  async wait() { return { status: 'succeeded' }; },",
      "  async stop() {},",
      "};",
    ].join("\n"));

    const discover = "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'ENG-8',title:'Harness plugin task'}]}))";
    await writeFile(join(root, ".task-relay.yaml"), stringify({
      version: 2,
      project: { name: "harness-plugin-test" },
      sources: { queue: { uses: "command", with: { discover: { command: process.execPath, args: ["-e", discover] } } } },
      harnesses: { custom: { uses: "./harness.mjs", with: { flavour: "configured" } } },
      actions: { implement: { uses: "launch", with: { harness: "custom", model: "some-model", prompt: "Do {{key}} in {{workspace}}" } } },
      triggers: [{ id: "ready", source: "queue", actions: ["implement"] }],
      // A harness plugin starts its own process, so no tmux adapter is needed.
      execution: { adapter: "process" },
      workspace: { adapter: "git-worktree", directory: ".task-relay/workspaces", baseBranch: "main" },
      logging: { level: "silent", pretty: false },
    }));

    // A worker needs a real workspace, so the fixture needs a real repository.
    for (const args of [["init", "-b", "main"], ["config", "user.email", "relay@example.invalid"], ["config", "user.name", "Relay Test"], ["commit", "--allow-empty", "-m", "init"]]) {
      await execa("git", ["-C", root, ...args]);
    }

    const tick = await run(root, "once", "--trigger", "ready");
    expect(tick.errors).toBe("");
    expect(tick.output).toContain("1 workers launched");

    const launched = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
    expect(launched.workerId).toBe("ENG-8:custom");
    expect(launched.model).toBe("some-model");
    expect(launched.config).toEqual({ flavour: "configured" });
    expect(launched.prompt).toContain("Do ENG-8 in ");
  });

  it("normalizes v1 files and reloads the v2 document printed by init dry-run", async () => {
    const v1Root = await mkdtemp(join(tmpdir(), "task-relay-v1-app-"));
    await writeFile(join(v1Root, ".task-relay.yaml"), `version: 1\nsources:\n  queue:\n    type: command\n    discover: { command: ${process.execPath} }\nagents:\n  codex:\n    command: codex\ntriggers:\n  - id: ready\n    source: queue\n    label: ready\n    agent: codex\n`);
    const normalized = await loadRelayConfig(v1Root);
    expect(normalized.config).toMatchObject({ version: 2, sources: { queue: { use: "command" } }, actions: { "legacy.launch.ready": { use: "launch" } } });

    const initRoot = await mkdtemp(join(tmpdir(), "task-relay-init-dry-run-"));
    const dryRun = await run(initRoot, "init", "--yes", "--dry-run", "--harness", "opencode", "--model", "gpt-5.6-terra", "--prompt", "Review {{item.id}}");
    const documentStart = dryRun.output.indexOf("# Task Relay configuration.");
    expect(documentStart).toBeGreaterThanOrEqual(0);
    await writeFile(join(initRoot, ".task-relay.yaml"), dryRun.output.slice(documentStart));
    const reloaded = await loadRelayConfig(initRoot);
    expect(reloaded.config).toMatchObject({
      version: 2,
      harnesses: { opencode: { use: "opencode" } },
      actions: { implement: { use: "launch", with: { harness: "opencode", model: "gpt-5.6-terra", prompt: "Review {{item.id}}" } } },
    });
    expect(reloaded.config.triggers[0].actions).toEqual(["implement"]);
    expect(await readFile(join(initRoot, ".task-relay.yaml"), "utf8")).toContain("version: 2");
  });

  it("rejects malformed Linear match rules and duplicate action ids before discovery", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-invalid-state-"));
    temporaryStateHomes.push(stateHome);
    process.env.XDG_STATE_HOME = stateHome;
    const invalidLinearRoot = await mkdtemp(join(tmpdir(), "task-relay-invalid-linear-"));
    await writeFile(join(invalidLinearRoot, ".task-relay.yaml"), stringify({
      version: 2,
      sources: { linear: { use: "linear", with: { mcp: { transport: "stdio", command: "unused" } } } },
      actions: { implement: { use: "launch", with: { harness: "codex" } } },
      harnesses: { codex: { use: "codex" } },
      triggers: [{ id: "invalid", source: "linear", match: { labels: { all: [1] } }, actions: ["implement"] }],
    }));
    await expect(run(invalidLinearRoot, "trigger", "test", "invalid")).rejects.toThrow(/invalid Linear match/);

    const duplicateRoot = await mkdtemp(join(tmpdir(), "task-relay-duplicate-action-"));
    await writeFile(join(duplicateRoot, ".task-relay.yaml"), stringify({
      version: 2,
      sources: { queue: { use: "command", with: { discover: { command: process.execPath } } } },
      actions: { notify: { use: "command", with: { command: process.execPath } } },
      triggers: [{ id: "duplicate", source: "queue", actions: ["notify", "notify"] }],
    }));
    await expect(run(duplicateRoot, "trigger", "test", "duplicate")).rejects.toThrow(/action id 'notify' more than once/);

    const processRoot = await mkdtemp(join(tmpdir(), "task-relay-interactive-process-"));
    await writeFile(join(processRoot, ".task-relay.yaml"), stringify({
      version: 2,
      sources: { queue: { use: "command", with: { discover: { command: process.execPath } } } },
      harnesses: { claude: { use: "claude" } },
      actions: { implement: { use: "launch", with: { harness: "claude", mode: "interactive" } } },
      triggers: [{ id: "interactive", source: "queue", actions: ["implement"] }],
      execution: { adapter: "process" },
    }));
    await expect(run(processRoot, "trigger", "test", "interactive")).rejects.toThrow(/interactive mode.*requires execution\.adapter: tmux/);
  });
});
