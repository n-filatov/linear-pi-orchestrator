import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
    expect(tick.output).toContain("Tick complete: 1 actions");
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
