import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createRuntimeHandlers } from "../src/app.js";
import { createRelayProgram, type RelayCommandContext } from "../src/cli/program.js";
import { loadRelayConfig } from "../src/config/load.js";
import { createEventLogger } from "../src/logging/events.js";
import { RepositoryStateStore } from "../src/state/store.js";
import type { RunRecord } from "../src/domain/index.js";

const originalStateHome = process.env.XDG_STATE_HOME;
afterEach(() => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
});

async function contextFor(document: Record<string, unknown>): Promise<RelayCommandContext> {
  const root = await mkdtemp(join(tmpdir(), "task-relay-claude-handoff-"));
  process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "task-relay-claude-handoff-state-"));
  await writeFile(join(root, ".task-relay.yaml"), stringify(document));
  const loaded = await loadRelayConfig(root);
  return {
    projectRoot: loaded.projectRoot,
    config: loaded.config,
    store: new RepositoryStateStore(loaded.projectRoot),
    logger: createEventLogger(loaded.projectRoot, "silent", false),
    write: () => {},
  };
}

function baseRunRecord(root: string, worker: RunRecord["worker"]): RunRecord {
  const repository = { id: "claude-handoff-test", root };
  return {
    id: "run-ENG-1",
    identity: { repository, sourceId: "queue", itemId: "ENG-1", triggerId: "implement" },
    item: { sourceId: "queue", id: "ENG-1", title: "Persist worker lookup" },
    trigger: { id: "implement", sourceId: "queue", repository, enabled: true },
    agent: { agentId: "claude", model: "claude-opus-5" },
    status: "running",
    claimedAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:00.000Z",
    worker,
  };
}

const minimalProject = {
  version: 2,
  project: { name: "claude-handoff-test" },
  sources: { queue: { use: "command", with: { discover: { command: process.execPath, args: ["-e", "0"] } } } },
  logging: { level: "silent", pretty: false },
};

describe("handoff handler", () => {
  it("refuses a target with no worker", async () => {
    const context = await contextFor(minimalProject);
    const handlers = createRuntimeHandlers();
    await expect(handlers.handoff!(context, "ENG-1", {})).rejects.toThrow(/No worker found for 'ENG-1'/);
  });

  it("refuses a worker that is not a Claude Code session", async () => {
    const context = await contextFor(minimalProject);
    await context.store.update(baseRunRecord(context.projectRoot, { id: "worker-1", startedAt: "2026-09-28T12:00:00.000Z", metadata: { tmux: { session: "s", window: "w", target: "@1" } } }));
    const handlers = createRuntimeHandlers();
    await expect(handlers.handoff!(context, "ENG-1", {})).rejects.toThrow(/is not a Claude Code session/);
  });

  it("is wired into the CLI as 'relay handoff <task-or-worker> [--force]'", async () => {
    let received: { target: string; options: { force?: boolean } } | undefined;
    const stdout = captureStream();
    const root = await mkdtemp(join(tmpdir(), "task-relay-handoff-cli-"));
    process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "task-relay-handoff-cli-state-"));
    await writeFile(join(root, ".task-relay.yaml"), stringify(minimalProject));
    const cliProgram = createRelayProgram({
      stdout: stdout.stream,
      cwd: () => root,
      handlers: {
        handoff: async (_context, target, options) => {
          received = { target, options };
          return { target: "claude-app", handedOffAt: "now", chainStatus: "succeeded", link: "claude://claude.ai/epitaxy/local_abc" };
        },
      },
    });
    await cliProgram.parseAsync(["node", "relay", "handoff", "ENG-1", "--force"]);
    expect(received).toEqual({ target: "ENG-1", options: { force: true } });
    expect(stdout.output()).toContain("claude://claude.ai/epitaxy/local_abc");
  });
});

describe("attach handler and a Claude session worker", () => {
  it("points at 'relay handoff --force' for a headless, not-yet-handed-off Claude session", async () => {
    const context = await contextFor(minimalProject);
    await context.store.update(baseRunRecord(context.projectRoot, {
      id: "worker-1", startedAt: "2026-09-28T12:00:00.000Z",
      metadata: { claudeSession: { sessionId: "sess-1", cwd: context.projectRoot } },
    }));
    const messages: string[] = [];
    const handlers = createRuntimeHandlers();
    await handlers.attach!({ ...context, write: (value) => messages.push(value) }, "ENG-1");
    expect(messages.join("\n")).toContain("relay handoff ENG-1 --force");
    expect(messages.join("\n")).toContain("headless");
  });
});

function captureStream() {
  const chunks: string[] = [];
  const stream = {
    write: (chunk: string) => { chunks.push(chunk); return true; },
  } as unknown as NodeJS.WriteStream;
  return { stream, output: () => chunks.join("") };
}
