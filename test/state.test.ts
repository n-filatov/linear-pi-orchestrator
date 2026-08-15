import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepositoryStateStore } from "../src/state/store.js";
import { TaskRelay } from "../src/core/task-relay.js";
import type { AgentLauncher, RelayLogger, RepositoryScope, TriggerDefinition, WorkItem, WorkSource, WorkspaceProvider } from "../src/domain/index.js";

const logger: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe("RepositoryStateStore", () => {
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
});
