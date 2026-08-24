import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepositoryStateStore } from "../src/state/store.js";
import { TaskRelay } from "../src/core/task-relay.js";
import { builtInActionPlugins } from "../src/actions/builtins.js";
import { RelayPluginRegistry } from "../src/plugins/index.js";
import type { AgentLauncher, RelayLogger, RepositoryScope, TriggerDefinition, WorkItem, WorkflowDefinition, WorkSource, WorkspaceProvider } from "../src/domain/index.js";

const logger: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe("RepositoryStateStore", () => {
  it("resolves worker targets for a workflow cleanup job", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-workflow-cleanup-"));
    const originalStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const repository: RepositoryScope = { id: "workflow-cleanup", root: join(stateHome, "repo") };
      const item: WorkItem = { sourceId: "queue", id: "DONE-1", title: "Done", terminal: true };
      const implementation: TriggerDefinition = { id: "implementation", sourceId: "queue", repository, enabled: true };
      const store = new RepositoryStateStore(repository.root);
      const claimed = await store.claim({
        id: "unused", identity: { repository, sourceId: "queue", itemId: item.id, triggerId: implementation.id },
        item, trigger: implementation, agent: { agentId: "codex" }, claimedAt: "claimed", maxConcurrent: 1,
      });
      await store.update({ ...claimed!, status: "running", workspace: { path: "/work/DONE-1" }, worker: { id: "worker-DONE-1", startedAt: "started" } });
      const migratedImplementation = { ...implementation, id: "implementation:job" };
      const migrated = await store.claim({
        id: "unused", identity: { repository, sourceId: "queue", itemId: item.id, triggerId: migratedImplementation.id },
        item, trigger: migratedImplementation, agent: { agentId: "codex" }, claimedAt: "migrated", maxConcurrent: 1,
      });
      await store.update({ ...migrated!, status: "running", workspace: { path: "/work/DONE-1" }, worker: { id: "worker-DONE-1-migrated", startedAt: "started" } });

      const workflow: WorkflowDefinition = {
        id: "cleanup-terminal", sourceId: "queue", repository, enabled: true,
        targets: { workers: { sourceItem: "current", runs: "all" } },
        jobs: [{ id: "cleanup", use: "cleanup", config: { activeWorker: "stop" } }],
      };
      const plugins = new RelayPluginRegistry();
      for (const plugin of builtInActionPlugins()) plugins.registerAction(plugin);
      const stopped: string[] = [];
      const cleaned: string[] = [];
      const relay = new TaskRelay({
        triggers: { list: async () => [] }, workflows: { list: async () => [workflow] }, workflowRuns: store,
        sources: [{ id: "queue", discover: async () => [item], report: async () => {} }], runStore: store,
        workspaceProvider: { provision: async () => ({ path: "/unused" }), cleanup: async (workspace) => { cleaned.push(workspace.path); } },
        agentLauncher: { resolve: async () => ({ agentId: "codex" }), launch: async () => ({ id: "unused", startedAt: "now" }), stop: async (worker) => { stopped.push(worker.id); } },
        actionPlugins: plugins, logger,
      });

      await relay.tick();
      expect(stopped).toEqual(["worker-DONE-1-migrated", "worker-DONE-1"]);
      expect(cleaned).toEqual(["/work/DONE-1"]);
      expect((await store.getRun(claimed!.id))?.workspaceCleanedAt).toBeTruthy();
      expect((await store.getRun(migrated!.id))?.workspaceCleanedAt).toBeTruthy();
      const workflowRun = (await store.listWorkflowRuns(repository))[0];
      expect(workflowRun?.jobs.cleanup.status).toBe("succeeded");
    } finally {
      if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = originalStateHome;
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("claims capacity atomically when two relays dispatch different work", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-state-"));
    const originalStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const repository: RepositoryScope = { id: "concurrent", root: join(stateHome, "repo") };
      const trigger: TriggerDefinition = { id: "ready", sourceId: "queue", repository, enabled: true, maxConcurrent: 1, agent: { id: "codex" } };
      const workspace: WorkspaceProvider = { provision: async (run) => ({ path: `/work/${run.item.id}` }) };
      const agent: AgentLauncher = {
        resolve: async () => ({ agentId: "codex" }),
        launch: async (spec) => ({ id: spec.item.id, startedAt: "now" }),
      };
      const relayFor = (item: WorkItem) => {
        const source: WorkSource = { id: "queue", discover: async () => [item], report: async () => {} };
        return new TaskRelay({
          triggers: { list: async () => [trigger] },
          sources: [source],
          runStore: new RepositoryStateStore(repository.root),
          workspaceProvider: workspace,
          agentLauncher: agent,
          logger,
        });
      };
      const [left, right] = await Promise.all([
        relayFor({ sourceId: "queue", id: "TASK-A", title: "A" }).tick(),
        relayFor({ sourceId: "queue", id: "TASK-B", title: "B" }).tick(),
      ]);
      expect(left.runsLaunched + right.runsLaunched).toBe(1);
      const runs = await new RepositoryStateStore(repository.root).listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("running");
    } finally {
      if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = originalStateHome;
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("atomically accepts only one competing terminal transition", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-state-"));
    const originalStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const repository: RepositoryScope = { id: "terminal-race", root: join(stateHome, "repo") };
      const trigger: TriggerDefinition = { id: "ready", sourceId: "queue", repository, enabled: true, maxConcurrent: 1, agent: { id: "codex" } };
      const store = new RepositoryStateStore(repository.root);
      const identity = { repository, sourceId: "queue", itemId: "TASK-1", triggerId: trigger.id };
      const claimed = await store.claim({
        id: "unused",
        identity,
        item: { sourceId: "queue", id: "TASK-1", title: "Task" },
        trigger,
        agent: { agentId: "codex" },
        claimedAt: "claimed",
        maxConcurrent: 1,
      });
      expect(claimed).toBeTruthy();
      const [success, stopped] = await Promise.all([
        store.finishActive(identity, "claimed", { status: "succeeded", completedAt: "success" }),
        new RepositoryStateStore(repository.root).finishActive(identity, "claimed", { status: "stopped", completedAt: "stopped" }),
      ]);
      expect([success, stopped].filter(Boolean)).toHaveLength(1);
      expect((await store.getRun(claimed!.id))?.status).toBe(success ? "succeeded" : "stopped");
    } finally {
      if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = originalStateHome;
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("records workspace cleanup without erasing the terminal result", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-cleaned-"));
    const originalStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const repository: RepositoryScope = { id: "cleaned", root: join(stateHome, "repo") };
      const trigger: TriggerDefinition = { id: "ready", sourceId: "queue", repository, enabled: true, maxConcurrent: 1 };
      const identity = { repository, sourceId: "queue", itemId: "TASK-A", triggerId: trigger.id };
      const store = new RepositoryStateStore(repository.root);
      await store.claim({
        id: "unused",
        identity,
        item: { sourceId: "queue", id: "TASK-A", title: "A" },
        trigger,
        agent: { agentId: "codex" },
        claimedAt: "claimed",
        maxConcurrent: 1,
      });
      await store.finishActive(identity, "claimed", { status: "succeeded", completedAt: "finished" });

      const cleaned = await store.markWorkspaceCleaned(identity, "claimed", "cleaned");

      expect(cleaned).toMatchObject({ status: "succeeded", completedAt: "finished", workspaceCleanedAt: "cleaned", updatedAt: "cleaned" });
    } finally {
      if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = originalStateHome;
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("appends worker children without erasing a terminal result or an earlier child", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-children-"));
    const originalStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const repository: RepositoryScope = { id: "children", root: join(stateHome, "repo") };
      const trigger: TriggerDefinition = { id: "ready", sourceId: "queue", repository, enabled: true, maxConcurrent: 1 };
      const identity = { repository, sourceId: "queue", itemId: "TASK-C", triggerId: trigger.id };
      const store = new RepositoryStateStore(repository.root);
      const claimed = await store.claim({
        id: "unused",
        identity,
        item: { sourceId: "queue", id: "TASK-C", title: "C" },
        trigger,
        agent: { agentId: "codex" },
        claimedAt: "claimed",
        maxConcurrent: 1,
      });
      claimed!.worker = { id: "worker-c", startedAt: "claimed", metadata: { tmux: { session: "s", target: "@1" } } };
      await store.update(claimed!);

      const child = (name: string) => ({ id: `worker-c:${name}`, kind: "pane" as const, target: `%${name}`, name, command: name, startedAt: "now" });
      await store.recordWorkerChild(identity, "claimed", child("dev"), "opened-1");
      // The worker exits between the two panes; the second append must not
      // resurrect it, and must not drop the first child.
      await store.finishActive(identity, "claimed", { status: "succeeded", completedAt: "finished" });
      const second = await store.recordWorkerChild(identity, "claimed", child("lint"), "opened-2");

      expect(second).toMatchObject({ status: "succeeded", completedAt: "finished", updatedAt: "opened-2" });
      expect(second?.worker?.metadata?.children).toEqual([child("dev"), child("lint")]);
      expect(second?.worker?.metadata?.tmux).toEqual({ session: "s", target: "@1" });

      // A stale generation is refused outright.
      await expect(store.recordWorkerChild(identity, "a-different-claim", child("late"), "opened-3")).resolves.toBeUndefined();
    } finally {
      if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = originalStateHome;
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("persists idempotent action executions with structured results", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-actions-"));
    const originalStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const repository: RepositoryScope = { id: "actions", root: join(stateHome, "repo") };
      const store = new RepositoryStateStore(repository.root);
      const claim = {
        idempotencyKey: "linear:ENG-123:notify:v1",
        triggerId: "notify-ready",
        actionId: "slack",
        sourceId: "linear",
        itemId: "ENG-123",
        claimedAt: "2026-01-01T00:00:00.000Z",
        input: { channel: "agents", labels: ["relay:implement"] },
      };

      const [left, right] = await Promise.all([
        store.claimActionExecution(claim),
        new RepositoryStateStore(repository.root).claimActionExecution(claim),
      ]);
      const execution = left ?? right;
      expect(execution).toMatchObject({ id: claim.idempotencyKey, status: "running", input: claim.input });
      expect([left, right].filter(Boolean)).toHaveLength(1);

      const finished = await store.finishActionExecution(claim.idempotencyKey, claim.claimedAt, {
        status: "succeeded",
        completedAt: "2026-01-01T00:01:00.000Z",
        output: { messageId: "slack-42", delivered: true },
      });
      expect(finished).toMatchObject({ status: "succeeded", output: { messageId: "slack-42", delivered: true } });
      expect(await store.finishActionExecution(claim.idempotencyKey, claim.claimedAt, {
        status: "failed",
        completedAt: "2026-01-01T00:02:00.000Z",
        error: { message: "late result" },
      })).toBeUndefined();
      expect(await store.claimAction(claim)).toBeUndefined();
      expect(await store.listActionExecutions({ sourceId: "linear", statuses: ["succeeded"] })).toHaveLength(1);
    } finally {
      if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = originalStateHome;
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it("finds worker targets by source item or explicit worker id without retrying cleaned workspaces", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-worker-targets-"));
    const originalStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const repository: RepositoryScope = { id: "worker-targets", root: join(stateHome, "repo") };
      const store = new RepositoryStateStore(repository.root);
      const createRun = async (triggerId: string, claimedAt: string, workerId?: string) => {
        const trigger: TriggerDefinition = { id: triggerId, sourceId: "linear", repository, enabled: true };
        const identity = { repository, sourceId: "linear", itemId: "ENG-123", triggerId };
        const run = await store.claim({
          id: "unused",
          identity,
          item: { sourceId: "linear", id: "ENG-123", title: "Task" },
          trigger,
          agent: { agentId: "codex" },
          claimedAt,
          maxConcurrent: 5,
        });
        if (!run) throw new Error("Expected test run to be claimed");
        if (!workerId) return run;
        const withWorker = {
          ...run,
          status: "running" as const,
          workspace: { path: join(stateHome, workerId) },
          worker: { id: workerId, startedAt: claimedAt },
        };
        await store.update(withWorker);
        return withWorker;
      };

      const active = await createRun("implementation", "2026-01-03T00:00:00.000Z", "worker-active");
      const completed = await createRun("review", "2026-01-02T00:00:00.000Z", "worker-cleaned");
      await store.finishActive(completed.identity, completed.claimedAt, { status: "succeeded", completedAt: "2026-01-02T00:01:00.000Z" });
      await store.markWorkspaceCleaned(completed.identity, completed.claimedAt, "2026-01-02T00:02:00.000Z");
      await createRun("notification", "2026-01-01T00:00:00.000Z");

      expect(await store.findRunsForItem({ repository, sourceId: "linear", itemId: "ENG-123" })).toHaveLength(3);
      expect((await store.findWorkerTargets({ repository, sourceId: "linear", itemId: "ENG-123", selection: "all" })).map((run) => run.worker?.id)).toEqual(["worker-active"]);
      expect((await store.findWorkerTargets({ repository, workerIds: ["worker-cleaned"], includeCleaned: true, selection: "latest" })).map((run) => run.worker?.id)).toEqual(["worker-cleaned"]);
      expect((await store.findWorkerTargets({ repository, sourceId: "linear", itemId: "ENG-123", selection: "active" })).map((run) => run.id)).toEqual([active.id]);
      await expect(store.findWorkerTargets({ repository })).rejects.toThrow(/sourceId and itemId/);
    } finally {
      if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = originalStateHome;
      await rm(stateHome, { recursive: true, force: true });
    }
  });
});
