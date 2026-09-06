import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TaskRelay } from "../src/core/task-relay.js";
import { RepositoryStateStore } from "../src/state/store.js";
import { RelayPluginRegistry, type VersionedActionPlugin } from "../src/plugins/index.js";
import type { WorkItem, WorkflowDefinition } from "../src/domain/index.js";
import { stateDirectory } from "../src/logging/events.js";

const originalHome = process.env.XDG_STATE_HOME;
const stores: RepositoryStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  if (originalHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalHome;
});

async function fixture(legacyItem?: WorkItem) {
  const root = await mkdtemp(join(tmpdir(), "relay-recovery-"));
  process.env.XDG_STATE_HOME = root;
  const repository = { id: "recovery", root };
  if (legacyItem) {
    const directory = stateDirectory(root);
    await mkdir(directory, { recursive: true });
    const identity = { repository, workflowId: "flow", sourceId: "fixture", itemId: legacyItem.id, occurrence: "change-legacy-hash" };
    const id = JSON.stringify([repository.id, root, "flow", "fixture", legacyItem.id, identity.occurrence]);
    await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, runs: {}, actions: {}, workflows: {
      [id]: { id, identity, item: legacyItem, status: "running", jobs: { one: { status: "started", attempts: 1 } }, startedAt: "2026-09-04T10:00:00Z", updatedAt: "2026-09-04T10:00:00Z" },
    } }));
  }
  const store = new RepositoryStateStore(root, { migrateLegacy: Boolean(legacyItem) });
  stores.push(store);
  const item: WorkItem = { id: "T-1", sourceId: "fixture", title: "Task", description: "Details" };
  let discover: () => Promise<readonly WorkItem[]> = async () => [item];
  let now = new Date("2026-09-05T10:00:00Z");
  const registry = new RelayPluginRegistry();
  const workflow: WorkflowDefinition = { id: "flow", sourceId: "fixture", repository, enabled: true, jobs: [] };
  const create = () => new TaskRelay({
    triggers: { list: async () => [] }, workflows: { list: async () => [workflow] },
    workflowRuns: store, runStore: store, actionPlugins: registry,
    sources: [{ id: "fixture", discover: () => discover(), report: async () => {} }],
    workspaceProvider: { provision: async () => ({ path: root }) },
    agentLauncher: { resolve: async () => ({ agentId: "test" }), launch: async () => ({ id: "test", startedAt: now.toISOString() }) },
    logger: { debug() {}, info() {}, warn() {}, error() {} }, now: () => now,
  });
  return { store, registry, workflow, create, repository, setDiscovery: (value: typeof discover) => { discover = value; }, setNow: (value: string) => { now = new Date(value); } };
}

function action(use: string, execute: VersionedActionPlugin["execute"]): VersionedActionPlugin {
  return { kind: "action", apiVersion: 1, use, configSchema: z.unknown(), inputSchema: z.unknown(), execute };
}

describe("durable workflow execution", () => {
  it("launches a reopened on-change item once despite an older migration-held run", async () => {
    const oldItem: WorkItem = { id: "T-1", sourceId: "fixture", title: "Task", metadata: { linearStatus: "In Progress", linearUpdatedAt: "2026-09-04T10:00:00Z" } };
    const f = await fixture(oldItem);
    let calls = 0;
    f.registry.register(action("count", async () => { calls++; return { status: "succeeded" }; }));
    f.workflow.firePolicy = "on-change";
    f.workflow.jobs = [{ id: "one", use: "count" }];
    f.setDiscovery(async () => [oldItem]);
    await f.create().tick();
    expect(calls).toBe(0); // The same held revision still requires inspection.
    f.setDiscovery(async () => [{ ...oldItem, metadata: { ...oldItem.metadata, linearUpdatedAt: "2026-09-05T10:00:00Z" } }]);
    await f.create().tick();
    await f.create().tick();
    expect(calls).toBe(1);
    const runs = await f.store.listWorkflowRuns(f.repository);
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.identity.occurrence === "change-legacy-hash"))
      .toMatchObject({ status: "running", needsAttention: true, jobs: { one: { attempts: 1 } } });
    expect(runs.filter((run) => run.status === "succeeded")).toHaveLength(1);
  });

  it.each(["every-poll", "once-per-match"] as const)("retains active subject coalescing for %s", async (policy) => {
    const f = await fixture({ id: "T-1", sourceId: "fixture", title: "Old title" });
    let calls = 0;
    f.registry.register(action("count", async () => { calls++; return { status: "succeeded" }; }));
    f.workflow.firePolicy = policy;
    f.workflow.jobs = [{ id: "one", use: "count" }];
    await f.create().tick();
    expect(calls).toBe(0);
    expect(await f.store.listWorkflowRuns(f.repository)).toHaveLength(1);
  });

  it("resumes deferred work from the saved definition after discovery fails", async () => {
    const f = await fixture();
    let calls = 0;
    f.registry.register(action("defer", async () => ++calls === 1
      ? { status: "deferred", retryAt: "2026-09-05T10:00:30Z", reason: "waiting" }
      : { status: "succeeded", output: { done: true } }));
    f.workflow.jobs = [{ id: "one", use: "defer" }];
    await f.create().tick();
    f.workflow.jobs = [{ id: "changed", use: "not-installed" }];
    f.setDiscovery(async () => { throw new Error("offline"); });
    await f.create().tick();
    expect(calls).toBe(1);
    f.setNow("2026-09-05T10:01:00Z");
    await f.create().tick();
    expect(calls).toBe(2);
    const [run] = await f.store.listWorkflowRuns(f.repository);
    expect(run.status).toBe("succeeded");
    expect(run.jobs.one.outputs).toEqual({ done: true });
    expect(run.jobs.changed).toBeUndefined();
  });

  it("claims before execution when two relay instances race", async () => {
    const f = await fixture();
    let calls = 0;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    f.registry.register(action("hold", async () => { calls++; await waiting; return { status: "succeeded" }; }));
    f.workflow.jobs = [{ id: "one", use: "hold" }];
    const first = f.create().tick();
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await f.create().tick();
    expect(calls).toBe(1);
    release();
    await first;
    expect((await f.store.listWorkflowRuns(f.repository))[0].jobs.one.attempts).toBe(1);
  });

  it("validates resolved typed inputs and persists upstream outputs", async () => {
    const f = await fixture();
    const received: unknown[] = [];
    f.registry.register(action("produce", async () => ({ status: "succeeded", output: { count: 3 } })));
    f.registry.register({ ...action("consume", async (_, input) => { received.push(input); return { status: "succeeded" }; }), inputSchema: z.object({ count: z.number(), prompt: z.string() }) });
    f.workflow.jobs = [
      { id: "first", use: "produce" },
      { id: "second", use: "consume", needs: [{ job: "first" }], config: { count: "${{ needs.first.outputs.count }}", prompt: "${{ item.description }}" } },
    ];
    await f.create().tick();
    expect(received).toEqual([{ count: 3, prompt: "Details" }]);
    expect((await f.store.listWorkflowRuns(f.repository))[0].jobs.second.input).toEqual(received[0]);
  });

  it("keeps same-subject durable trigger events as separate workflow occurrences", async () => {
    const f = await fixture();
    let calls = 0;
    f.registry.register(action("count", async () => { calls += 1; return { status: "succeeded", output: { calls } }; }));
    f.workflow.jobs = [{ id: "one", use: "count" }];
    f.setDiscovery(async () => [
      { id: "T-1", sourceId: "fixture", title: "Task", triggerEvent: { id: "event-a", payload: { value: 1 } } },
      { id: "T-1", sourceId: "fixture", title: "Task", triggerEvent: { id: "event-b", payload: { value: 2 } } },
    ]);
    await f.create().tick();
    expect(calls).toBe(2);
    const runs = await f.store.listWorkflowRuns(f.repository);
    expect(runs.map((run) => run.identity.occurrence).sort()).toEqual(["event-event-a", "event-event-b"]);
    await f.create().tick();
    expect(calls).toBe(2);
  });

  it("makes a versioned worker action with no targets terminally skipped", async () => {
    const f = await fixture();
    f.registry.register({ ...action("worker-step", async () => ({ status: "succeeded" })), target: "worker" });
    f.workflow.jobs = [{ id: "one", use: "worker-step" }];
    await f.create().tick();
    const [run] = await f.store.listWorkflowRuns(f.repository);
    expect(run.jobs.one.status).toBe("skipped");
    expect(run.status).toBe("succeeded");
  });

  it("requests cancellation before timing out an external operation", async () => {
    const f = await fixture();
    let cancelled = 0;
    f.registry.register({
      ...action("external", async () => ({ status: "running", operation: { id: "op-1" } })),
      cancel: async () => { cancelled += 1; return { status: "succeeded", output: { cancelled: true } }; },
    });
    f.workflow.timeoutMs = 1_000;
    f.workflow.jobs = [{ id: "one", use: "external" }];
    await f.create().tick();
    f.setNow("2026-09-05T10:00:02Z");
    await f.create().tick();
    const [run] = await f.store.listWorkflowRuns(f.repository);
    expect(cancelled).toBe(1);
    expect(run.status).toBe("failed");
    expect(run.jobs.one.status).toBe("omitted");
  });

  it("passes the durable attempt identity and lease to a workflow action", async () => {
    const f = await fixture();
    let contextAttempt: string | undefined;
    let contextLease: string | undefined;
    f.registry.register(action("identity", async (context) => {
      contextAttempt = context.attemptId;
      contextLease = context.leaseExpiresAt;
      return { status: "succeeded" };
    }));
    f.workflow.jobs = [{ id: "one", use: "identity" }];
    await f.create().tick();
    expect(contextAttempt).toEqual(expect.any(String));
    expect(contextLease).toEqual(expect.any(String));
    const [run] = await f.store.listWorkflowRuns(f.repository);
    expect(run.jobs.one.attemptHistory?.[0]?.attemptId).toBe(contextAttempt);
  });
});
