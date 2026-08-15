import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { stateDirectory } from "../logging/events.js";
import { createRunKey, isActiveRun, type RepositoryScope, type RunClaim, type RunIdentity, type RunRecord, type RunStore } from "../domain/types.js";

type StateData = { version: 1; runs: Record<string, RunRecord> };

export { type RunRecord } from "../domain/types.js";
export function taskStateKey(identity: RunIdentity): string { return createRunKey(identity); }

/** JSON state with an advisory write lock. One file is used per repository scope. */
export class RepositoryStateStore implements RunStore {
  readonly directory: string;
  readonly file: string;
  constructor(projectRoot: string) { this.directory = stateDirectory(projectRoot); this.file = join(this.directory, "state.json"); }

  private ensure(): void { mkdirSync(this.directory, { recursive: true }); if (!existsSync(this.file)) writeFileAtomic.sync(this.file, `${JSON.stringify({ version: 1, runs: {} })}\n`); }
  private read(): StateData { this.ensure(); try { const value = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StateData>; return { version: 1, runs: value.runs || {} }; } catch { return { version: 1, runs: {} }; } }
  async snapshot(): Promise<StateData> { return this.read(); }
  async listRuns(): Promise<RunRecord[]> { return Object.values((await this.snapshot()).runs).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async getRun(id: string): Promise<RunRecord | undefined> { return (await this.snapshot()).runs[id]; }
  async findActive(identity: RunIdentity): Promise<RunRecord | undefined> {
    const run = (await this.snapshot()).runs[taskStateKey(identity)];
    return run && isActiveRun(run.status) ? run : undefined;
  }
  async countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">): Promise<number> {
    return (await this.listRuns()).filter((run) => isActiveRun(run.status) && run.identity.repository.id === identity.repository.id && run.identity.repository.root === identity.repository.root && run.identity.sourceId === identity.sourceId && run.identity.triggerId === identity.triggerId).length;
  }
  async claim(claim: RunClaim): Promise<RunRecord | undefined> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const state = this.read(); const id = taskStateKey(claim.identity); const existing = state.runs[id];
      if (existing && isActiveRun(existing.status)) return undefined;
      const run: RunRecord = { id, identity: claim.identity, item: claim.item, trigger: claim.trigger, agent: claim.agent, status: "claimed", claimedAt: claim.claimedAt, updatedAt: claim.claimedAt };
      state.runs[id] = run; await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`); return run;
    }
    finally { await release(); }
  }
  async update(run: RunRecord): Promise<void> {
    this.ensure();
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try { const state = this.read(); state.runs[run.id] = run; await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`); }
    finally { await release(); }
  }
  async listActive(repository: RepositoryScope): Promise<readonly RunRecord[]> {
    return (await this.listRuns()).filter((run) => isActiveRun(run.status) && run.identity.repository.id === repository.id && run.identity.repository.root === repository.root);
  }
}
