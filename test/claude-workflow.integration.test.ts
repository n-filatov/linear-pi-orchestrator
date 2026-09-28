import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtInActionPlugins } from "../src/actions/builtins.js";
import { CompositeAgentLauncher } from "../src/agents/plugin-harness.js";
import { CLAUDE_SESSION_HARNESS_ID, ClaudeSessionHarness } from "../src/claude/index.js";
import { domainWorkflow } from "../src/app.js";
import { normalizeRelayConfig } from "../src/config/v2.js";
import { TaskRelay } from "../src/core/task-relay.js";
import { InMemoryWorkflowRunStore } from "../src/application/in-memory-workflow-run-store.js";
import {
  createRunKey,
  isActiveRun,
  type AgentLauncher,
  type RelayLogger,
  type RepositoryScope,
  type RunClaim,
  type RunIdentity,
  type RunRecord,
  type RunStore,
  type RunTerminalTransition,
  type SourceEvent,
  type WorkerChildHandle,
  type WorkItem,
  type WorkspaceProvider,
  type WorkSource,
  workerChildren,
} from "../src/domain/index.js";
import { ProjectWorkspaceProvider } from "../src/workspaces/index.js";
import { RelayPluginRegistry } from "../src/plugins/index.js";

/**
 * A slimmed copy of `MemoryRunStore` from `test/actions.test.ts`, extended
 * only with what a persistent Claude worker's launch/handoff lifecycle needs.
 */
class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();

  async findActive(identity: RunIdentity): Promise<RunRecord | undefined> {
    const run = this.runs.get(createRunKey(identity));
    return run && isActiveRun(run.status) ? run : undefined;
  }

  async countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">): Promise<number> {
    return [...this.runs.values()].filter((run) => isActiveRun(run.status)
      && sameRepository(run.identity.repository, identity.repository)
      && run.identity.sourceId === identity.sourceId
      && run.identity.triggerId === identity.triggerId).length;
  }

  async claim(claim: RunClaim): Promise<RunRecord | undefined> {
    const id = createRunKey(claim.identity);
    if (await this.findActive(claim.identity) || await this.countActive(claim.identity) >= claim.maxConcurrent) return undefined;
    const { maxConcurrent: _maxConcurrent, ...rest } = claim;
    const run: RunRecord = { ...rest, id, status: "claimed", updatedAt: claim.claimedAt };
    this.runs.set(id, run);
    return run;
  }

  async finishActive(identity: RunIdentity, claimedAt: string, transition: RunTerminalTransition): Promise<RunRecord | undefined> {
    const run = this.runs.get(createRunKey(identity));
    if (!run || !isActiveRun(run.status) || run.claimedAt !== claimedAt) return undefined;
    const finished: RunRecord = { ...run, status: transition.status, completedAt: transition.completedAt, updatedAt: transition.completedAt, error: transition.error };
    this.runs.set(finished.id, finished);
    return finished;
  }

  async markWorkspaceCleaned(identity: RunIdentity, claimedAt: string, cleanedAt: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(createRunKey(identity));
    if (!run || run.claimedAt !== claimedAt) return undefined;
    const cleaned = { ...run, workspaceCleanedAt: cleanedAt, updatedAt: cleanedAt };
    this.runs.set(cleaned.id, cleaned);
    return cleaned;
  }

  async update(run: RunRecord): Promise<void> { this.runs.set(run.id, structuredClone(run)); }

  async recordWorkerChild(identity: RunIdentity, claimedAt: string, child: WorkerChildHandle, recordedAt: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(createRunKey(identity));
    if (!run || run.claimedAt !== claimedAt || !run.worker) return undefined;
    const updated: RunRecord = {
      ...run,
      worker: { ...run.worker, metadata: { ...run.worker.metadata, children: [...workerChildren(run.worker), child] } },
      updatedAt: recordedAt,
    };
    this.runs.set(updated.id, updated);
    return updated;
  }

  async listActive(scope: RepositoryScope): Promise<readonly RunRecord[]> {
    return [...this.runs.values()].filter((run) => sameRepository(run.identity.repository, scope) && isActiveRun(run.status));
  }

  async findRunsForItem(query: {
    repository: RepositoryScope;
    sourceId: string;
    itemId: string;
    selection?: "latest" | "active" | "all";
    includeCleaned?: boolean;
  }): Promise<readonly RunRecord[]> {
    return this.findWorkerTargets(query);
  }

  async findWorkerTargets(query: {
    repository: RepositoryScope;
    sourceId?: string;
    itemId?: string;
    selection?: "latest" | "active" | "all";
    workerIds?: readonly string[];
    includeCleaned?: boolean;
  }): Promise<readonly RunRecord[]> {
    const ids = new Set(query.workerIds ?? []);
    const runs = [...this.runs.values()]
      .filter((run) => sameRepository(run.identity.repository, query.repository) && Boolean(run.worker))
      .filter((run) => query.includeCleaned || !run.workspaceCleanedAt)
      .filter((run) => !query.sourceId || run.identity.sourceId === query.sourceId)
      .filter((run) => !query.itemId || run.identity.itemId === query.itemId)
      .filter((run) => ids.size === 0 || ids.has(run.worker!.id))
      .sort((left, right) => right.claimedAt.localeCompare(left.claimedAt));
    if (query.selection === "active") return runs.filter((run) => isActiveRun(run.status));
    return query.selection === "latest" ? runs.slice(0, 1) : runs;
  }
}

function sameRepository(left: RepositoryScope, right: RepositoryScope): boolean {
  return left.id === right.id && left.root === right.root;
}

/** Records every `report()` call a workflow run makes, in order. */
function fakeSource(id: string, items: readonly WorkItem[]): { source: WorkSource; events: SourceEvent[] } {
  const events: SourceEvent[] = [];
  return {
    events,
    source: {
      id,
      discover: async () => items,
      report: async (event: SourceEvent) => { events.push(event); },
    },
  };
}

const logger: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Writes a fake `claude` executable that records every invocation's argv to
 * `argvLog`, then prints a scripted `init` line followed by a `result` line
 * whose text is `done: <last argument>` (the prompt is always the last CLI
 * argument `ClaudeSessionHarness` passes). Real `claude`/`open`/`git` are
 * never invoked by this test.
 */
function writeFakeClaude(binDir: string, argvLog: string, isError: boolean): string {
  const script = join(binDir, "claude");
  writeFileSync(script, [
    "#!/usr/bin/env bash",
    "set -e",
    `printf '%s\\n' "$*" >> "${argvLog}"`,
    'last="${@: -1}"',
    'echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"cwd\\":\\"$(pwd)\\",\\"session_id\\":\\"test\\"}"',
    `echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":${isError},\\"result\\":\\"done: $last\\"}"`,
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
  return script;
}

const item: WorkItem = { sourceId: "queue", id: "ITEM-1", title: "Add a dev server" };

describe("claude workflow: session -> implement -> brief -> open-in-app", () => {
  let root: string;
  let binDir: string;
  let projectRoot: string;
  let stateDirectory: string;
  let sessionsDirectory: string;
  let argvLog: string;
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-workflow-"));
    binDir = join(root, "bin");
    projectRoot = join(root, "project");
    stateDirectory = join(root, "state");
    sessionsDirectory = join(root, "sessions");
    argvLog = join(root, "argv.log");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(sessionsDirectory, { recursive: true });
    writeFileSync(argvLog, "");
    cleanupDirs.push(root);
  });

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function readArgvLines(): string[] {
    return readFileSync(argvLog, "utf8").split("\n").filter(Boolean);
  }

  /** Ticks the relay repeatedly, with a short real delay between ticks so the
   * detached fake `claude` process has time to write its result line, until
   * `check` passes or the timeout elapses. */
  async function tickUntil(relay: TaskRelay, check: () => boolean, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      await relay.tick();
      if (check()) return;
      if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for the workflow to progress.");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  function buildWorkflow(repository: RepositoryScope) {
    const config = normalizeRelayConfig({
      version: 2,
      sources: { queue: { use: "command", with: { discover: { command: "/bin/echo" } } } },
      workflows: {
        "claude-flow": {
          on: { source: "queue" },
          jobs: {
            session: { use: "claude.start-session", with: {} },
            implement: {
              use: "claude.send-prompt",
              needs: "session.Started",
              with: { session: { action: "session" }, prompt: "Implement ${{ item.id }}" },
            },
            brief: {
              use: "claude.send-prompt",
              needs: "implement",
              with: { session: { action: "session" }, prompt: "Brief ${{ item.id }}" },
            },
            "open-in-app": {
              use: "claude.open-in-app",
              needs: "brief",
              if: "${{ always() }}",
              with: { session: { action: "session" } },
            },
          },
        },
      },
    });
    return domainWorkflow(config, "claude-flow", config.workflows["claude-flow"], repository);
  }

  function buildRelay(options: { runStore: MemoryRunStore; source: WorkSource; workflow: ReturnType<typeof buildWorkflow>; innerProvisions: string[]; workflowRuns?: InMemoryWorkflowRunStore }): TaskRelay {
    const harness = new ClaudeSessionHarness({
      stateDirectory,
      sessionsDirectory,
      command: join(binDir, "claude"),
      openUrl: async (url: string) => { openedUrls.push(url); },
      platform: "darwin",
      sleep: async () => undefined,
      runGit: async () => undefined,
      handoffSpacingMs: 0,
    });
    const commandsStub: AgentLauncher = {
      resolve: async () => { throw new Error("The command launcher should never be used by this workflow."); },
      launch: async () => { throw new Error("The command launcher should never be used by this workflow."); },
    };
    const agentLauncher = new CompositeAgentLauncher(commandsStub, [
      { id: CLAUDE_SESSION_HARNESS_ID, plugin: harness, config: {} },
    ]);
    const innerWorkspaceProvider: WorkspaceProvider = {
      provision: async (run) => { options.innerProvisions.push(run.id); return { path: "/should-not-be-used" }; },
    };
    const registry = new RelayPluginRegistry();
    for (const plugin of builtInActionPlugins()) registry.registerAction(plugin);
    return new TaskRelay({
      triggers: { list: async () => [] },
      workflows: { list: async () => [options.workflow] },
      workflowRuns: options.workflowRuns,
      sources: [options.source],
      runStore: options.runStore,
      workspaceProvider: ProjectWorkspaceProvider(innerWorkspaceProvider, projectRoot),
      agentLauncher,
      actionPlugins: registry,
      logger,
    });
  }

  let openedUrls: string[];

  beforeEach(() => { openedUrls = []; });

  it("runs a persistent Claude session through implement, brief, and hand-off", async () => {
    writeFakeClaude(binDir, argvLog, false);
    const repository: RepositoryScope = { id: "claude-workflow", root: projectRoot };
    const workflow = buildWorkflow(repository);
    const runStore = new MemoryRunStore();
    const { source, events } = fakeSource("queue", [item]);
    const innerProvisions: string[] = [];
    const relay = buildRelay({ runStore, source, workflow, innerProvisions });

    await tickUntil(relay, () => events.some((event) => event.type === "succeeded" || event.type === "failed"));
    // A couple more ticks let `refreshWorkflowJobs` observe the now-finished
    // session worker and settle the whole workflow run.
    await relay.tick();
    await relay.tick();

    expect(innerProvisions).toEqual([]);

    const lines = readArgvLines();
    expect(lines).toHaveLength(2);
    const [turn1, turn2] = lines;
    expect(turn1).toContain("--worktree");
    expect(turn1).toContain("--session-id");
    expect(turn1).toContain("--name");
    expect(turn1).not.toContain("--resume");
    expect(turn1).toContain("Implement ITEM-1");

    expect(turn2).toContain("--resume");
    expect(turn2).not.toContain("--worktree");
    expect(turn2).not.toContain("--session-id");
    expect(turn2).not.toContain("--name");
    expect(turn2).toContain("Brief ITEM-1");

    const sessionIdMatch = /--session-id (\S+)/.exec(turn1);
    const resumeMatch = /--resume (\S+)/.exec(turn2);
    expect(sessionIdMatch?.[1]).toBeDefined();
    expect(resumeMatch?.[1]).toBe(sessionIdMatch?.[1]);
    const sessionId = sessionIdMatch![1]!;

    expect(openedUrls).toEqual([`claude://resume?session=${sessionId}`]);

    const succeeded = events.find((event) => event.type === "succeeded");
    expect(succeeded).toBeDefined();
    const outputs = succeeded!.run.worker!.metadata!.outputs as { claudeSession: { link: string; lastResult?: string } };
    expect(outputs.claudeSession.link).toBe(`claude://claude.ai/epitaxy/local_${sessionId}`);
    expect(outputs.claudeSession.lastResult).toBe("done: Brief ITEM-1");
  }, 20_000);

  it("omits brief and still opens the app when the implement turn fails", async () => {
    writeFakeClaude(binDir, argvLog, true);
    const repository: RepositoryScope = { id: "claude-workflow-failure", root: projectRoot };
    const workflow = buildWorkflow(repository);
    const runStore = new MemoryRunStore();
    const { source, events } = fakeSource("queue", [item]);
    const innerProvisions: string[] = [];
    const relay = buildRelay({ runStore, source, workflow, innerProvisions });

    await tickUntil(relay, () => events.some((event) => event.type === "succeeded" || event.type === "failed"));

    expect(innerProvisions).toEqual([]);
    const lines = readArgvLines();
    // Only the implement turn ever runs; brief is omitted before it can start one.
    expect(lines).toHaveLength(1);

    const failed = events.find((event) => event.type === "failed");
    expect(failed).toBeDefined();
    expect(openedUrls).toHaveLength(1);
  }, 20_000);

  it("stops the session worker when the run finishes without a handoff", async () => {
    writeFakeClaude(binDir, argvLog, true);
    const repository: RepositoryScope = { id: "claude-workflow-no-handoff", root: projectRoot };
    // Unlike the other workflows in this file, `open-in-app` is NOT gated by
    // `always()`: when `implement` fails, `brief` and `open-in-app` are both
    // omitted, so nothing ever hands the persistent session off. Regression
    // test for the session worker created by `claude.start-session` staying
    // "running" forever once its workflow run finished failed.
    const config = normalizeRelayConfig({
      version: 2,
      sources: { queue: { use: "command", with: { discover: { command: "/bin/echo" } } } },
      workflows: {
        "claude-flow": {
          on: { source: "queue" },
          jobs: {
            session: { use: "claude.start-session", with: {} },
            implement: {
              use: "claude.send-prompt",
              needs: "session.Started",
              with: { session: { action: "session" }, prompt: "Implement ${{ item.id }}" },
            },
            brief: {
              use: "claude.send-prompt",
              needs: "implement",
              with: { session: { action: "session" }, prompt: "Brief ${{ item.id }}" },
            },
            "open-in-app": {
              use: "claude.open-in-app",
              needs: "brief",
              with: { session: { action: "session" } },
            },
          },
        },
      },
    });
    const workflow = domainWorkflow(config, "claude-flow", config.workflows["claude-flow"], repository);
    const runStore = new MemoryRunStore();
    const workflowRuns = new InMemoryWorkflowRunStore();
    const { source, events } = fakeSource("queue", [item]);
    const innerProvisions: string[] = [];
    const relay = buildRelay({ runStore, source, workflow, innerProvisions, workflowRuns });

    const start = Date.now();
    for (;;) {
      await relay.tick();
      const runs = await workflowRuns.listWorkflowRuns(repository);
      if (runs.some((run) => run.status !== "running")) break;
      if (Date.now() - start > 15_000) throw new Error("Timed out waiting for the workflow run to finish.");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    // The chain failed without ever calling handoff.
    expect(openedUrls).toEqual([]);
    expect(events.some((event) => event.type === "succeeded" || event.type === "failed")).toBe(false);

    // The session worker `claude.start-session` launched must not be left
    // running: it should have been stopped once the workflow run finished.
    const sessionRuns = [...runStore.runs.values()].filter((run) => run.worker?.metadata?.persistent === true);
    expect(sessionRuns).toHaveLength(1);
    expect(isActiveRun(sessionRuns[0]!.status)).toBe(false);
    expect(sessionRuns[0]!.status).toBe("stopped");
  }, 20_000);
});
