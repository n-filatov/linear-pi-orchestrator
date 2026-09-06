import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateDirectory } from "../src/logging/events.js";
import { RepositoryStateStore } from "../src/state/store.js";
import type { RepositoryScope, WorkflowRunIdentity } from "../src/domain/types.js";

async function temporaryRepository() {
  const home = await mkdtemp(join(tmpdir(), "relay-sqlite-ledger-"));
  const root = join(home, "repo");
  const repository: RepositoryScope = { id: "ledger", root };
  return { home, root, repository };
}

describe("SQLite execution ledger", () => {
  it("admits one capacity claim across independent relay processes", async () => {
    const fixture = await temporaryRepository(); const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const script = `import { RepositoryStateStore } from './src/state/store.ts'; (async () => { const [root,item] = process.argv.slice(-2); const repository={id:'process-race',root}; const store=new RepositoryStateStore(root); const claimed=await store.claim({identity:{repository,sourceId:'queue',itemId:item,triggerId:'ready'},item:{sourceId:'queue',id:item,title:item},trigger:{id:'ready',sourceId:'queue',repository,enabled:true,maxConcurrent:1},agent:{agentId:'codex'},claimedAt:item,maxConcurrent:1}); console.log(claimed ? 'claimed' : 'rejected'); })();`;
      const run = (item: string) => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, fixture.root, item], { cwd: process.cwd(), env: { ...process.env, XDG_STATE_HOME: fixture.home } });
      const [left, right] = await Promise.all([run("one"), run("two")]);
      expect([left.stdout, right.stdout].filter(value => value.trim() === "claimed")).toHaveLength(1);
      expect(await new RepositoryStateStore(fixture.root).listRuns()).toHaveLength(1);
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });
  it("requires an explicit, validated JSON cutover and retains a backup", async () => {
    const fixture = await temporaryRepository();
    const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const directory = stateDirectory(fixture.root); await mkdir(directory, { recursive: true });
      const legacy = { version: 1, runs: {}, actions: {}, workflows: {} };
      await writeFile(join(directory, "state.json"), JSON.stringify(legacy));
      expect(() => new RepositoryStateStore(fixture.root)).toThrow(/relay state migrate/);
      const store = new RepositoryStateStore(fixture.root, { migrateLegacy: true });
      expect(await store.snapshot()).toMatchObject(legacy);
      await expect((await import("node:fs/promises")).readFile(join(directory, "state.json.pre-sqlite-backup"), "utf8")).resolves.toBe(JSON.stringify(legacy));
      store.close();
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });

  it("does not mark a busy JSON migration complete and can resume after the lock clears", async () => {
    const fixture = await temporaryRepository(); const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const directory = stateDirectory(fixture.root); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, runs: {}, actions: {}, workflows: {} }));
      await mkdir(join(directory, "state.json.lock"));
      expect(() => new RepositoryStateStore(fixture.root, { migrateLegacy: true })).toThrow(/state is busy/);
      await rm(join(directory, "state.json.lock"), { recursive: true });
      const resumed = new RepositoryStateStore(fixture.root, { migrateLegacy: true });
      expect(await resumed.snapshot()).toMatchObject({ version: 1, runs: {}, actions: {}, workflows: {} });
      resumed.close();
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });

  it("recovers an interrupted import only after its recorded owner is gone", async () => {
    const fixture = await temporaryRepository(); const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const directory = stateDirectory(fixture.root); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, runs: {}, actions: {}, workflows: {} }));
      const lock = join(directory, "state.json.lock"); await mkdir(lock);
      await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: "interrupted" }));

      const resumed = new RepositoryStateStore(fixture.root, { migrateLegacy: true });
      expect(await resumed.snapshot()).toMatchObject({ version: 1, runs: {}, actions: {}, workflows: {} });
      resumed.close();
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });

  it("refuses corrupt legacy JSON without accepting an empty ledger", async () => {
    const fixture = await temporaryRepository(); const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const directory = stateDirectory(fixture.root); await mkdir(directory, { recursive: true }); await writeFile(join(directory, "state.json"), "not json");
      expect(() => new RepositoryStateStore(fixture.root, { migrateLegacy: true })).toThrow(/not valid JSON/);
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });

  it("imports an active legacy workflow as an inspectable definition hold", async () => {
    const fixture = await temporaryRepository(); const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const directory = stateDirectory(fixture.root); await mkdir(directory, { recursive: true });
      const identity = { repository: fixture.repository, workflowId: "deploy", sourceId: "command", itemId: "legacy", occurrence: "once" };
      const id = JSON.stringify([fixture.repository.id, fixture.repository.root, "deploy", "command", "legacy", "once"]);
      await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, runs: {}, actions: {}, workflows: {
        [id]: { id, identity, item: { sourceId: "command", id: "legacy", title: "Legacy" }, status: "running", jobs: { deploy: { status: "started", attempts: 1 } }, startedAt: "a", updatedAt: "b" },
      } }));
      const store = new RepositoryStateStore(fixture.root, { migrateLegacy: true });
      const imported = await store.findWorkflowRun(identity);
      expect(imported).toMatchObject({ status: "running", needsAttention: true, migration: { provenance: "legacy-json", reason: "definition_snapshot_missing" }, jobs: { deploy: { status: "started", attempts: 1 } } });
      expect(await store.adoptWorkflowDefinition(identity, { id: "wrong", sourceId: "command", repository: fixture.repository, enabled: true, jobs: [] }, "c")).toBeUndefined();
      const adopted = await store.adoptWorkflowDefinition(identity, { id: "deploy", sourceId: "command", repository: fixture.repository, enabled: true, jobs: [] }, "d");
      expect(adopted).toMatchObject({ definition: { id: "deploy" } });
      expect(adopted?.needsAttention).toBeUndefined();
      store.close();
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });

  it("claims one workflow attempt and refuses stale completion", async () => {
    const fixture = await temporaryRepository(); const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const store = new RepositoryStateStore(fixture.root);
      const identity: WorkflowRunIdentity = { repository: fixture.repository, workflowId: "build", sourceId: "command", itemId: "one", occurrence: "event-1" };
      await store.openWorkflowRun({ identity, item: { sourceId: "command", id: "one", title: "One" }, startedAt: "2026-01-01T00:00:00Z" });
      const [left, right] = await Promise.all([store.claimWorkflowJob(identity, "build", { at: "a", attemptId: "attempt-a" }), new RepositoryStateStore(fixture.root).claimWorkflowJob(identity, "build", { at: "b", attemptId: "attempt-b" })]);
      const winner = left?.jobs.build.attemptId ?? right?.jobs.build.attemptId;
      expect(winner).toBeTruthy();
      expect([left, right].filter(Boolean)).toHaveLength(1);
      expect(await store.updateWorkflowJob(identity, "build", { status: "succeeded", at: "missing-token" })).toBeUndefined();
      expect(await store.updateWorkflowJob(identity, "build", { status: "succeeded", at: "c", expectedAttemptId: winner === "attempt-a" ? "attempt-b" : "attempt-a" })).toBeUndefined();
      const updated = await store.updateWorkflowJob(identity, "build", { status: "succeeded", at: "d", expectedAttemptId: winner! });
      expect(updated?.jobs.build.status).toBe("succeeded");
      expect(updated?.jobs.build.attempts).toBe(1);
      await store.finishWorkflowRun(identity, "succeeded", "e");
      await expect(store.claimWorkflowJob(identity, "later", { at: "f", attemptId: "later" })).resolves.toBeUndefined();
      store.close();
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });

  it("keeps uncertain work claimed until an explicit retry", async () => {
    const fixture = await temporaryRepository(); const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const store = new RepositoryStateStore(fixture.root);
      const identity: WorkflowRunIdentity = { repository: fixture.repository, workflowId: "build", sourceId: "command", itemId: "two", occurrence: "event-2" };
      await store.openWorkflowRun({ identity, item: { sourceId: "command", id: "two", title: "Two" }, startedAt: "a" });
      await store.claimWorkflowJob(identity, "deploy", { at: "b", attemptId: "attempt-1", input: { ticket: "two" } });
      const flagged = await store.markWorkflowJobNeedsAttention(identity, "deploy", "attempt-1", "c", "process outcome unknown");
      expect(flagged?.jobs.deploy).toMatchObject({ attemptId: "attempt-1", needsAttention: true, input: { ticket: "two" } });
      expect(await store.claimWorkflowJob(identity, "deploy", { at: "d", attemptId: "attempt-2" })).toBeUndefined();
      const retried = await store.retryWorkflowJobs(identity, ["deploy"], "e");
      expect(retried?.jobs.deploy).toMatchObject({ status: "pending", input: { ticket: "two" } });
      const claimed = await store.claimWorkflowJob(identity, "deploy", { at: "f", attemptId: "attempt-2" });
      expect(claimed?.jobs.deploy).toMatchObject({ attemptId: "attempt-2", input: { ticket: "two" }, attempts: 2 });
      store.close();
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });

  it("uses action attempt generations when retry timestamps collide", async () => {
    const fixture = await temporaryRepository(); const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const store = new RepositoryStateStore(fixture.root);
      const claim = { idempotencyKey: "same-clock", triggerId: "trigger", actionId: "action", sourceId: "source", itemId: "item", claimedAt: "same" };
      const first = await store.claimActionExecution({ ...claim, attemptId: "attempt-1" });
      await store.finishActionExecution(claim.idempotencyKey, claim.claimedAt, { status: "failed", completedAt: "failed" }, first!.attemptId);
      const second = await store.claimActionExecution({ ...claim, attemptId: "attempt-2" });
      expect(await store.finishActionExecution(claim.idempotencyKey, claim.claimedAt, { status: "succeeded", completedAt: "stale" }, first!.attemptId)).toBeUndefined();
      expect(await store.finishActionExecution(claim.idempotencyKey, claim.claimedAt, { status: "succeeded", completedAt: "fresh" }, second!.attemptId)).toMatchObject({ status: "succeeded", attemptId: "attempt-2" });
      store.close();
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });

  it("marks an expired workflow lease uncertain and requires an explicit retry", async () => {
    const fixture = await temporaryRepository(); const original = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = fixture.home;
    try {
      const store = new RepositoryStateStore(fixture.root);
      const identity: WorkflowRunIdentity = { repository: fixture.repository, workflowId: "lease", sourceId: "command", itemId: "three", occurrence: "event-3" };
      await store.openWorkflowRun({ identity, item: { sourceId: "command", id: "three", title: "Three" }, startedAt: "a" });
      await store.claimWorkflowJob(identity, "run", { at: "b", attemptId: "attempt-1", leaseExpiresAt: "c", input: { stable: true } });
      const expired = await store.markExpiredWorkflowJobClaimsNeedsAttention("d");
      expect(expired[0]?.jobs.run).toMatchObject({ needsAttention: true, attemptId: "attempt-1", attemptHistory: [{ attemptId: "attempt-1", outcome: "uncertain" }] });
      expect(await store.renewWorkflowJobLease(identity, "run", "attempt-1", "z", "e")).toBeUndefined();
      expect(await store.claimWorkflowJob(identity, "run", { at: "f", attemptId: "attempt-2" })).toBeUndefined();
      await store.retryWorkflowJobs(identity, ["run"], "g");
      expect((await store.claimWorkflowJob(identity, "run", { at: "h", attemptId: "attempt-2", leaseExpiresAt: "i" }))?.jobs.run).toMatchObject({ attemptId: "attempt-2", input: { stable: true }, attempts: 2 });
      store.close();
    } finally { if (original === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = original; await rm(fixture.home, { recursive: true, force: true }); }
  });
});
