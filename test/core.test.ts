import { describe, expect, it } from "vitest";
import { TaskRelay } from "../src/core/task-relay.js";
import { createRunKey, isActiveRun, type AgentLauncher, type AgentResolution, type RelayLogger, type RepositoryScope, type RunClaim, type RunIdentity, type RunRecord, type RunStore, type TriggerDefinition, type WorkItem, type WorkSource, type WorkspaceProvider } from "../src/domain/index.js";

const repository: RepositoryScope = { id: "frontend", root: "/repo/frontend" };
const trigger: TriggerDefinition = { id: "ready", sourceId: "queue", repository, enabled: true, maxConcurrent: 2, agent: { id: "codex", model: "fast" } };
const items: WorkItem[] = [1, 2, 3].map((id) => ({ sourceId: "queue", id: `TASK-${id}`, title: `Task ${id}`, state: "open" }));

class MemoryStore implements RunStore {
  runs = new Map<string, RunRecord>();
  async findActive(identity: RunIdentity) { const run = this.runs.get(createRunKey(identity)); return run && isActiveRun(run.status) ? run : undefined; }
  async countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">) { return [...this.runs.values()].filter((run) => isActiveRun(run.status) && run.identity.repository.id === identity.repository.id && run.identity.sourceId === identity.sourceId && run.identity.triggerId === identity.triggerId).length; }
  async claim(claim: RunClaim) { const id = createRunKey(claim.identity); if (await this.findActive(claim.identity)) return undefined; const run: RunRecord = { ...claim, id, status: "claimed", updatedAt: claim.claimedAt }; this.runs.set(id, run); return run; }
  async update(run: RunRecord) { this.runs.set(run.id, structuredClone(run)); }
  async listActive(scope: RepositoryScope) { return [...this.runs.values()].filter((run) => run.identity.repository.id === scope.id && isActiveRun(run.status)); }
}

const logger: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe("TaskRelay", () => {
  it("claims only the remaining trigger capacity and does not duplicate active work", async () => {
    const store = new MemoryStore();
    const launched: string[] = [];
    const source: WorkSource = { id: "queue", discover: async () => items, report: async () => {} };
    const workspace: WorkspaceProvider = { provision: async (run) => ({ path: `/work/${run.item.id}`, branch: `relay/${run.item.id}` }) };
    const agent: AgentLauncher = {
      resolve: async (profile): Promise<AgentResolution> => ({ agentId: profile?.id || "codex", model: profile?.model }),
      launch: async (spec) => { launched.push(spec.item.id); return { id: spec.item.id, startedAt: "2026-08-15T00:00:00.000Z" }; },
    };
    const relay = new TaskRelay({ triggers: { list: async () => [trigger] }, sources: [source], runStore: store, workspaceProvider: workspace, agentLauncher: agent, logger });

    const first = await relay.tick();
    expect(first.runsLaunched).toBe(2);
    expect(first.skipped).toBe(1);
    expect(launched).toEqual(["TASK-1", "TASK-2"]);

    const second = await relay.tick();
    expect(second.runsLaunched).toBe(0);
    expect(launched).toHaveLength(2);
  });

  it("does not launch when the source cannot persist the claim", async () => {
    const store = new MemoryStore();
    let launches = 0;
    const source: WorkSource = { id: "queue", discover: async () => [items[0]], report: async (event) => { if (event.type === "claimed") throw new Error("claim failed"); } };
    const relay = new TaskRelay({
      triggers: { list: async () => [trigger] },
      sources: [source],
      runStore: store,
      workspaceProvider: { provision: async () => ({ path: "/work" }) },
      agentLauncher: { resolve: async () => ({ agentId: "codex" }), launch: async () => { launches += 1; return { id: "worker", startedAt: "now" }; } },
      logger,
    });
    const result = await relay.tick();
    expect(result.runsLaunched).toBe(0);
    expect(launches).toBe(0);
    expect([...store.runs.values()][0]?.status).toBe("failed");
  });
});
