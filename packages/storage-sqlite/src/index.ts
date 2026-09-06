import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createRunKey, createWorkflowRunKey, isActiveRun, isTerminalJobStatus, workerChildren, type RepositoryScope, type RunClaim, type RunIdentity, type RunRecord, type RunStore, type RunTerminalTransition, type WorkerChildHandle, type WorkflowDefinition, type WorkflowJobState, type WorkflowJobTransition, type WorkflowRunIdentity, type WorkflowRunRecord, type WorkflowRunStore, type WorkItem } from "@task-relay/domain";
type Stmt = {
    run(...v: unknown[]): unknown;
    get(...v: unknown[]): unknown;
    all(...v: unknown[]): unknown[];
};
type Db = {
    exec(sql: string): unknown;
    prepare(sql: string): Stmt;
    close(): void;
};
type DbCtor = new (file: string) => Db;
const sqlite = await import(process.versions.bun ? "bun:sqlite" : "node:sqlite") as Record<string, unknown>;
const Database = (sqlite.DatabaseSync ?? sqlite.Database) as DbCtor;
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type ActionExecutionStatus = "running" | "succeeded" | "failed" | "skipped";
export interface ActionExecutionRecord {
    id: string;
    idempotencyKey: string;
    triggerId: string;
    actionId: string;
    sourceId: string;
    itemId: string;
    status: ActionExecutionStatus;
    claimedAt: string;
    /** Distinguishes retries that happen to share an identical clock value. */
    attemptId: string;
    leaseExpiresAt?: string;
    needsAttention?: boolean;
    updatedAt: string;
    completedAt?: string;
    input?: JsonValue;
    output?: JsonValue;
    error?: JsonValue;
}
export interface ActionExecutionClaimInput {
    idempotencyKey: string;
    triggerId: string;
    actionId: string;
    sourceId: string;
    itemId: string;
    claimedAt: string;
    attemptId?: string;
    /** Advisory only: expiry is surfaced for inspection, never auto-replayed. */
    leaseExpiresAt?: string;
    input?: JsonValue;
}
export interface ActionExecutionTransition {
    status: Exclude<ActionExecutionStatus, "running">;
    completedAt: string;
    output?: JsonValue;
    error?: JsonValue;
}
export interface ActionExecutionFilter {
    triggerId?: string;
    actionId?: string;
    sourceId?: string;
    itemId?: string;
    statuses?: readonly ActionExecutionStatus[];
}
export type WorkerTargetSelection = "latest" | "active" | "all";
export interface RunItemLookup {
    repository: RepositoryScope;
    sourceId: string;
    itemId: string;
    selection?: WorkerTargetSelection;
    includeCleaned?: boolean;
}
export interface WorkerTargetLookup {
    repository: RepositoryScope;
    sourceId?: string;
    itemId?: string;
    workerIds?: readonly string[];
    selection?: WorkerTargetSelection;
    includeCleaned?: boolean;
}
export interface TriggerEventRecord { id: string; bindingId: string; subjectKey: string; observedAt: string; payload: JsonValue; status: "pending" | "accepted" | "processed"; cursor?: JsonValue; }
export interface RepositoryStateStoreOptions { migrateLegacy?: boolean; }
type State = {
    version: 1;
    runs: Record<string, RunRecord>;
    actions: Record<string, ActionExecutionRecord>;
    workflows: Record<string, WorkflowRunRecord>;
};
type Row = {
    payload_json: string;
};
export { type RunRecord } from "@task-relay/domain";
export function taskStateKey(identity: RunIdentity): string { return createRunKey(identity); }

/** The stable, per-checkout location of Relay's authoritative execution ledger. */
function repositoryStateDirectory(projectRoot: string): string {
    const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    const root = resolve(projectRoot);
    const name = basename(root).replace(/[^a-zA-Z0-9._-]/g, "-") || "project";
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
    return join(base, "task-relay", `${name}-${hash}`);
}
/** Per-repository authoritative SQLite ledger. `state.json` is legacy import-only. */
export class RepositoryStateStore implements RunStore, WorkflowRunStore {
    readonly directory: string;
    /** Legacy JSON source, retained for inspection and an untouched rollback backup. */
    readonly file: string;
    readonly databaseFile: string;
    private readonly db: Db;
    constructor(projectRoot: string, options: RepositoryStateStoreOptions = {}) {
        this.directory = repositoryStateDirectory(projectRoot);
        this.file = join(this.directory, "state.json");
        this.databaseFile = join(this.directory, "state.sqlite");
        mkdirSync(this.directory, { recursive: true });
        this.db = new Database(this.databaseFile);
        this.db.exec("PRAGMA foreign_keys = ON");
        this.db.exec("PRAGMA busy_timeout = 5000");
        // Changing journal mode takes an exclusive lock. One process may be
        // doing that first-open setup already; the mode is persistent, so a
        // competing opener can safely continue to its transactional work.
        try { this.db.exec("PRAGMA journal_mode = WAL"); }
        catch (error) { if (!isBusySqliteError(error)) throw error; }
        this.migrate(options.migrateLegacy === true);
    }
    close(): void { this.db.close(); }
    private tx<T>(fn: () => T): T {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const value = fn();
            this.db.exec("COMMIT");
            return value;
        } catch (error) {
            try { this.db.exec("ROLLBACK"); }
            catch { /* The transaction may not have opened. */ }
            throw error;
        }
    }
    private migrate(migrateLegacy: boolean): void {
        const version = Number((this.db.prepare("PRAGMA user_version").get() as {
            user_version?: number;
        } | undefined)?.user_version ?? 0);
        if (version === 0) {
            this.tx(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, repository_root TEXT NOT NULL, source_id TEXT NOT NULL, item_id TEXT NOT NULL, trigger_id TEXT NOT NULL, status TEXT NOT NULL, claimed_at TEXT NOT NULL, updated_at TEXT NOT NULL, workspace_cleaned_at TEXT, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_executions (idempotency_key TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, action_id TEXT NOT NULL, source_id TEXT NOT NULL, item_id TEXT NOT NULL, status TEXT NOT NULL, claimed_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, repository_root TEXT NOT NULL, workflow_id TEXT NOT NULL, source_id TEXT NOT NULL, item_id TEXT NOT NULL, occurrence TEXT NOT NULL, status TEXT NOT NULL, concurrency_group TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trigger_checkpoints (binding_id TEXT PRIMARY KEY, cursor_json TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trigger_events (id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, subject_key TEXT NOT NULL, observed_at TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, cursor_json TEXT);
      CREATE TABLE IF NOT EXISTS projection_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT);
      CREATE INDEX IF NOT EXISTS runs_active_lookup ON runs(repository_id, repository_root, source_id, trigger_id, status);
      CREATE INDEX IF NOT EXISTS runs_item_lookup ON runs(repository_id, repository_root, source_id, item_id, claimed_at DESC);
      CREATE INDEX IF NOT EXISTS workflows_group_lookup ON workflow_runs(repository_id, repository_root, concurrency_group, status, started_at);
      PRAGMA user_version = 1;`));
        }
        // Added after the initial ledger release; CREATE IF NOT EXISTS keeps
        // existing local ledgers forward-compatible without a destructive rewrite.
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS trigger_checkpoints (
              binding_id TEXT PRIMARY KEY, cursor_json TEXT, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS trigger_events (
              id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, subject_key TEXT NOT NULL,
              observed_at TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, cursor_json TEXT
            );
            CREATE TABLE IF NOT EXISTS projection_outbox (
              id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL, delivered_at TEXT
            );
        `);
        if (migrateLegacy) {
            this.importLegacyOnce();
        } else if (existsSync(this.file) && !this.db.prepare("SELECT 1 FROM ledger_metadata WHERE key = ?").get("legacy-json-imported")) {
            throw new Error(`Legacy Relay state exists at ${this.file}. Run 'relay state migrate' while Relay is stopped before starting the SQLite ledger.`);
        }
    }
    private importLegacyOnce(): void {
        if (this.db.prepare("SELECT 1 FROM ledger_metadata WHERE key = ?").get("legacy-json-imported"))
            return;
        if (!existsSync(this.file)) {
            this.db.prepare("INSERT INTO ledger_metadata VALUES (?, ?)").run("legacy-json-imported", "absent");
            return;
        }
        const legacyLock = `${this.file}.lock`;
        acquireMigrationLock(legacyLock, this.file);
        try {
            const before = legacyHash(this.file);
            const legacy = readLegacy(this.file);
            validateLegacy(legacy);
            const backup = `${this.file}.pre-sqlite-backup`;
            if (!existsSync(backup)) copyFileSync(this.file, backup);
            this.tx(() => {
                if (legacyHash(this.file) !== before) {
                    throw new Error("Legacy state.json changed during migration; stop old Relay writers and retry.");
                }
                for (const value of Object.values(legacy.runs)) this.saveRun(value, true);
                for (const value of Object.values(legacy.actions)) this.saveAction(value, true);
                for (const value of Object.values(legacy.workflows)) this.saveWorkflow(blockUnsafeLegacyWorkflow(value), true);

                const counts = this.importCounts();
                if (counts.runs < Object.keys(legacy.runs).length
                    || counts.actions < Object.keys(legacy.actions).length
                    || counts.workflows < Object.keys(legacy.workflows).length) {
                    throw new Error("SQLite ledger import count validation failed.");
                }
                this.db.prepare("INSERT OR REPLACE INTO ledger_metadata VALUES (?, ?)")
                    .run("legacy-json-imported", JSON.stringify({ at: new Date().toISOString(), hash: before, ...counts }));
            });
        } finally {
            rmSync(legacyLock, { recursive: true, force: true });
        }
    }
    private importCounts(): { runs: number; actions: number; workflows: number } {
        return {
            runs: this.runs().length,
            actions: Number((this.db.prepare("SELECT COUNT(*) AS count FROM action_executions").get() as { count: number }).count),
            workflows: this.workflows().length,
        };
    }
    private parse<T>(row: Row | undefined): T | undefined {
        return row ? JSON.parse(row.payload_json) as T : undefined;
    }
    private runs(): RunRecord[] {
        return (this.db.prepare("SELECT payload_json FROM runs").all() as Row[])
            .map(row => this.parse<RunRecord>(row)!);
    }
    private workflows(): WorkflowRunRecord[] {
        return (this.db.prepare("SELECT payload_json FROM workflow_runs").all() as Row[])
            .map(row => this.parse<WorkflowRunRecord>(row)!);
    }
    private run(id: string): RunRecord | undefined {
        return this.parse(this.db.prepare("SELECT payload_json FROM runs WHERE id = ?").get(id) as Row | undefined);
    }
    private action(key: string): ActionExecutionRecord | undefined {
        return this.parse(this.db.prepare("SELECT payload_json FROM action_executions WHERE idempotency_key = ?").get(key) as Row | undefined);
    }
    private workflow(id: string): WorkflowRunRecord | undefined {
        return this.parse(this.db.prepare("SELECT payload_json FROM workflow_runs WHERE id = ?").get(id) as Row | undefined);
    }
    private saveRun(run: RunRecord, preserve = false): void {
        if (preserve) {
            const old = this.run(run.id);
            if (old && old.updatedAt >= run.updatedAt) return;
        }
        this.db.prepare(`
            INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              repository_id=excluded.repository_id, repository_root=excluded.repository_root,
              source_id=excluded.source_id, item_id=excluded.item_id, trigger_id=excluded.trigger_id,
              status=excluded.status, claimed_at=excluded.claimed_at, updated_at=excluded.updated_at,
              workspace_cleaned_at=excluded.workspace_cleaned_at, payload_json=excluded.payload_json
        `).run(
            run.id, run.identity.repository.id, run.identity.repository.root, run.identity.sourceId,
            run.identity.itemId, run.identity.triggerId, run.status, run.claimedAt, run.updatedAt,
            run.workspaceCleanedAt ?? null, JSON.stringify(run),
        );
    }
    private saveAction(action: ActionExecutionRecord, preserve = false): void {
        if (preserve) {
            const old = this.action(action.idempotencyKey);
            if (old && old.updatedAt >= action.updatedAt) return;
        }
        this.db.prepare(`
            INSERT INTO action_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(idempotency_key) DO UPDATE SET
              trigger_id=excluded.trigger_id, action_id=excluded.action_id,
              source_id=excluded.source_id, item_id=excluded.item_id, status=excluded.status,
              claimed_at=excluded.claimed_at, updated_at=excluded.updated_at, payload_json=excluded.payload_json
        `).run(
            action.idempotencyKey, action.triggerId, action.actionId, action.sourceId, action.itemId,
            action.status, action.claimedAt, action.updatedAt, JSON.stringify(action),
        );
    }
    private saveWorkflow(run: WorkflowRunRecord, preserve = false): void {
      const previous = this.workflow(run.id);
      if (preserve && previous && previous.updatedAt >= run.updatedAt) return;
      run.revision = (previous?.revision ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO workflow_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          repository_id=excluded.repository_id, repository_root=excluded.repository_root,
          workflow_id=excluded.workflow_id, source_id=excluded.source_id, item_id=excluded.item_id,
          occurrence=excluded.occurrence, status=excluded.status, concurrency_group=excluded.concurrency_group,
          started_at=excluded.started_at, updated_at=excluded.updated_at, payload_json=excluded.payload_json
      `).run(
        run.id, run.identity.repository.id, run.identity.repository.root, run.identity.workflowId,
        run.identity.sourceId, run.identity.itemId, run.identity.occurrence, run.status,
        run.concurrencyGroup ?? null, run.startedAt, run.updatedAt, JSON.stringify(run),
      );
      this.enqueueWorkflowProjection(previous, run);
    }

    private enqueueWorkflowProjection(previous: WorkflowRunRecord | undefined, run: WorkflowRunRecord): void {
      const changedJob = Object.keys(run.jobs)
        .find(id => JSON.stringify(previous?.jobs[id]) !== JSON.stringify(run.jobs[id]));
      const type = !previous ? "workflow.opened"
        : run.status !== "running" ? "workflow.finished"
          : changedJob ? "workflow.job.updated" : "workflow.snapshot";
      const payload = {
        run,
        type,
        jobId: changedJob,
        data: changedJob ? { jobId: changedJob, status: run.jobs[changedJob].status } : { status: run.status },
      };
      this.db.prepare("INSERT INTO projection_outbox(topic,payload_json,created_at) VALUES(?,?,?)")
        .run("workflow.snapshot", JSON.stringify(payload), run.updatedAt);
    }

    async snapshot(): Promise<State> {
      const runs = Object.fromEntries(this.runs().map(run => [run.id, run]));
      const actions = Object.fromEntries((this.db.prepare("SELECT payload_json FROM action_executions").all() as Row[])
        .map(row => this.parse<ActionExecutionRecord>(row)!)
        .map(action => [action.idempotencyKey, action]));
      const workflows = Object.fromEntries(this.workflows().map(run => [run.id, run]));
      return { version: 1, runs, actions, workflows };
    }
    async listRuns(): Promise<RunRecord[]> {
      return this.runs().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    async getRun(id: string): Promise<RunRecord | undefined> { return this.run(id); }
    async listActionExecutions(filter: ActionExecutionFilter = {}): Promise<ActionExecutionRecord[]> {
      return (this.db.prepare("SELECT payload_json FROM action_executions").all() as Row[])
        .map(row => this.parse<ActionExecutionRecord>(row)!)
        .filter(action => matchesAction(action, filter))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    async getActionExecution(key: string): Promise<ActionExecutionRecord | undefined> { return this.action(key); }
    /** Marks expired external invocations for operator reconciliation; it never retries them. */
    async markExpiredActionExecutionsNeedsAttention(at: string): Promise<ActionExecutionRecord[]> {
      return this.tx(() => {
        const expired = (this.db.prepare("SELECT payload_json FROM action_executions WHERE status='running'").all() as Row[])
            .map(row => this.parse<ActionExecutionRecord>(row)!)
            .filter(value => value.leaseExpiresAt !== undefined && value.leaseExpiresAt <= at && !value.needsAttention);
        for (const value of expired) this.saveAction({ ...value, needsAttention: true, updatedAt: at });
        return expired.map(value => ({ ...value, needsAttention: true, updatedAt: at }));
      });
    }
    /** Extends a live action lease only for its owning attempt generation. */
    async renewActionExecutionLease(key: string, attemptId: string, leaseExpiresAt: string, at: string): Promise<ActionExecutionRecord | undefined> {
      return this.tx(() => {
        const current = this.action(key);
        if (!current || current.status !== "running" || current.attemptId !== attemptId || current.needsAttention) return undefined;
        const next = { ...current, leaseExpiresAt, updatedAt: at };
        this.saveAction(next);
        return next;
      });
    }
    async findActive(identity: RunIdentity): Promise<RunRecord | undefined> {
      const run = this.run(taskStateKey(identity));
      return run && isActiveRun(run.status) ? run : undefined;
    }
    async countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">): Promise<number> {
      return this.runs().filter(run => isActiveRun(run.status)
        && sameRepo(run.identity.repository, identity.repository)
        && run.identity.sourceId === identity.sourceId
        && run.identity.triggerId === identity.triggerId).length;
    }
    async findRunsForItem(query: RunItemLookup): Promise<RunRecord[]> {
      const matching = this.runs().filter(run => sameRepo(run.identity.repository, query.repository)
        && run.identity.sourceId === query.sourceId
        && run.identity.itemId === query.itemId
        && ((query.includeCleaned ?? true) || !run.workspaceCleanedAt));
      return select(matching, query.selection ?? "all");
    }
    async findWorkerTargets(query: WorkerTargetLookup): Promise<RunRecord[]> {
      const byId = Boolean(query.workerIds?.length);
      if (!byId && (!query.sourceId || !query.itemId)) {
        throw new Error("Worker target lookup requires sourceId and itemId, or at least one workerId.");
      }
      const ids = new Set(query.workerIds ?? []);
      const matching = this.runs().filter(run => sameRepo(run.identity.repository, query.repository)
        && Boolean(run.worker)
        && ((query.includeCleaned ?? false) || !run.workspaceCleanedAt)
        && (!query.sourceId || run.identity.sourceId === query.sourceId)
        && (!query.itemId || run.identity.itemId === query.itemId)
        && (!byId || ids.has(run.worker!.id)));
      return select(matching, query.selection ?? "all");
    }
    async claim(claim: RunClaim): Promise<RunRecord | undefined> {
      return this.tx(() => {
        const id = taskStateKey(claim.identity);
        const old = this.run(id);
        if (old && isActiveRun(old.status)) return undefined;
        if (this.activeCountFor(claim.identity) >= claim.maxConcurrent) return undefined;
        const run: RunRecord = {
          id, identity: claim.identity, item: claim.item, trigger: claim.trigger, agent: claim.agent,
          status: "claimed", claimedAt: claim.claimedAt, updatedAt: claim.claimedAt,
        };
        this.saveRun(run);
        return run;
      });
    }
    private activeCountFor(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">): number {
      return this.runs().filter(run => isActiveRun(run.status)
        && sameRepo(run.identity.repository, identity.repository)
        && run.identity.sourceId === identity.sourceId
        && run.identity.triggerId === identity.triggerId).length;
    }
    async claimActionExecution(claim: ActionExecutionClaimInput): Promise<ActionExecutionRecord | undefined> {
      assertClaim(claim);
      return this.tx(() => {
        const old = this.action(claim.idempotencyKey);
        if (old?.status === "running" || old?.status === "succeeded") return undefined;
        const action: ActionExecutionRecord = {
          id: claim.idempotencyKey, idempotencyKey: claim.idempotencyKey, triggerId: claim.triggerId,
          actionId: claim.actionId, sourceId: claim.sourceId, itemId: claim.itemId, status: "running",
          claimedAt: claim.claimedAt, attemptId: claim.attemptId ?? randomUUID(), updatedAt: claim.claimedAt,
          ...(claim.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: claim.leaseExpiresAt }),
          ...(claim.input === undefined ? {} : { input: claim.input }),
        };
        this.saveAction(action);
        return action;
      });
    }
    async finishActionExecution(key: string, claimedAt: string, transition: ActionExecutionTransition, expectedAttemptId?: string): Promise<ActionExecutionRecord | undefined> {
      assertTransition(transition);
      return this.tx(() => {
        const old = this.action(key);
        if (!old || old.status !== "running" || old.claimedAt !== claimedAt
          || old.attemptId !== expectedAttemptId) return undefined;
        const action = {
          ...old, status: transition.status, completedAt: transition.completedAt, updatedAt: transition.completedAt,
          ...(transition.output === undefined ? {} : { output: transition.output }),
          ...(transition.error === undefined ? {} : { error: transition.error }),
        };
        this.saveAction(action);
        return action;
      });
    }
    async claimAction(c: ActionExecutionClaimInput): Promise<ActionExecutionRecord | undefined> { return this.claimActionExecution(c); }
    async finishAction(k: string, a: string, t: ActionExecutionTransition, expectedAttemptId?: string): Promise<ActionExecutionRecord | undefined> { return this.finishActionExecution(k, a, t, expectedAttemptId); }
    async finishActive(i: RunIdentity, claimedAt: string, t: RunTerminalTransition): Promise<RunRecord | undefined> { return this.tx(() => { const old = this.run(taskStateKey(i)); if (!old || !isActiveRun(old.status) || old.claimedAt !== claimedAt)
        return undefined; const v = { ...old, status: t.status, error: t.error, completedAt: t.completedAt, updatedAt: t.completedAt }; this.saveRun(v); return v; }); }
    async markWorkspaceCleaned(i: RunIdentity, a: string, at: string): Promise<RunRecord | undefined> { return this.mutate(i, a, v => ({ ...v, workspaceCleanedAt: at, updatedAt: at })); }
    async recordWorkerChild(i: RunIdentity, a: string, child: WorkerChildHandle, at: string): Promise<RunRecord | undefined> { return this.mutate(i, a, v => v.worker ? { ...v, worker: { ...v.worker, metadata: { ...v.worker.metadata, children: [...workerChildren(v.worker), child] } }, updatedAt: at } : undefined); }
    async recordWorkerOutputs(i: RunIdentity, a: string, outputs: Record<string, unknown>, at: string): Promise<RunRecord | undefined> { return this.mutate(i, a, v => { if (!v.worker)
        return undefined; const before = v.worker.metadata?.outputs; const merged = before !== null && typeof before === "object" && !Array.isArray(before) ? { ...before, ...outputs } : { ...outputs }; return { ...v, worker: { ...v.worker, metadata: { ...v.worker.metadata, outputs: merged } }, updatedAt: at }; }); }
    private async mutate(i: RunIdentity, claimedAt: string, fn: (v: RunRecord) => RunRecord | undefined): Promise<RunRecord | undefined> { return this.tx(() => { const old = this.run(taskStateKey(i)); if (!old || old.claimedAt !== claimedAt)
        return undefined; const v = fn(old); if (v)
        this.saveRun(v); return v; }); }
    async update(v: RunRecord): Promise<void> { this.tx(() => this.saveRun(v)); }
    async listActive(r: RepositoryScope): Promise<readonly RunRecord[]> { return this.runs().filter(v => isActiveRun(v.status) && sameRepo(v.identity.repository, r)); }
    async openWorkflowRun(input: {
        identity: WorkflowRunIdentity;
        item: WorkItem;
        startedAt: string;
        timeoutAt?: string;
        concurrencyGroup?: string;
        definition?: WorkflowDefinition;
    }): Promise<WorkflowRunRecord> { return this.tx(() => { const id = createWorkflowRunKey(input.identity), old = this.workflow(id); if (old)
        return old; if (input.concurrencyGroup && this.db.prepare("SELECT 1 FROM workflow_runs WHERE repository_id=? AND repository_root=? AND concurrency_group=? AND status='running' LIMIT 1").get(input.identity.repository.id, input.identity.repository.root, input.concurrencyGroup))
        throw new Error(`Workflow concurrency group '${input.concurrencyGroup}' is already occupied.`); const v: WorkflowRunRecord = { id, identity: input.identity, item: input.item, status: "running", jobs: {}, startedAt: input.startedAt, updatedAt: input.startedAt, ...(input.timeoutAt ? { timeoutAt: input.timeoutAt } : {}), ...(input.concurrencyGroup ? { concurrencyGroup: input.concurrencyGroup } : {}), ...(input.definition ? { definition: input.definition } : {}) }; this.saveWorkflow(v); return v; }); }
    async findWorkflowRun(i: WorkflowRunIdentity): Promise<WorkflowRunRecord | undefined> { return this.workflow(createWorkflowRunKey(i)); }
    /** Deliberately attaches a validated current definition to a legacy hold. */
    async adoptWorkflowDefinition(i: WorkflowRunIdentity, definition: WorkflowDefinition, at: string): Promise<WorkflowRunRecord | undefined> { return this.tx(() => {
        const current = this.workflow(createWorkflowRunKey(i));
        if (!current || !current.needsAttention || current.migration?.reason !== "definition_snapshot_missing" || definition.id !== current.identity.workflowId) return undefined;
        const next = { ...current, definition, needsAttention: undefined, migration: undefined, updatedAt: at };
        this.saveWorkflow(next);
        return next;
    }); }
    async latestWorkflowRun(i: Omit<WorkflowRunIdentity, "occurrence">): Promise<WorkflowRunRecord | undefined> { return this.workflows().filter(v => sameRepo(v.identity.repository, i.repository) && v.identity.workflowId === i.workflowId && v.identity.sourceId === i.sourceId && v.identity.itemId === i.itemId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]; }
    async claimWorkflowJob(i: WorkflowRunIdentity, jobId: string, claim: {
        at: string;
        attemptId: string;
        input?: JsonValue;
        leaseExpiresAt?: string;
    }): Promise<WorkflowRunRecord | undefined> {
      return this.tx(() => {
        const run = this.workflow(createWorkflowRunKey(i));
        if (!run || run.status !== "running") return undefined;
        const old: WorkflowJobState = run.jobs[jobId] ?? { status: "pending", attempts: 0 };
        if (old.status !== "pending" || old.attemptId || old.needsAttention) return undefined;
        const job: WorkflowJobState = {
          ...old, attemptId: claim.attemptId, startedAt: old.startedAt ?? claim.at, attempts: old.attempts + 1,
          ...(claim.input === undefined ? {} : { input: claim.input }),
          ...(claim.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: claim.leaseExpiresAt }),
          attemptHistory: [...(old.attemptHistory ?? []), { attemptId: claim.attemptId, claimedAt: claim.at, status: "pending" }],
        };
        const next = { ...run, jobs: { ...run.jobs, [jobId]: job }, updatedAt: claim.at };
        this.saveWorkflow(next);
        return next;
      });
    }
    async updateWorkflowJob(i: WorkflowRunIdentity, jobId: string, t: WorkflowJobTransition): Promise<WorkflowRunRecord | undefined> {
      return this.tx(() => {
        const run = this.workflow(createWorkflowRunKey(i));
        if (!run || run.status !== "running") return undefined;
        const old: WorkflowJobState = run.jobs[jobId] ?? { status: "pending", attempts: 0 };
        if (isTerminalJobStatus(old.status) || old.attemptId !== t.expectedAttemptId && old.attemptId !== undefined) return undefined;
        const terminal = isTerminalJobStatus(t.status);
        const history = t.expectedAttemptId === undefined ? old.attemptHistory : (old.attemptHistory ?? []).map(entry =>
          entry.attemptId === t.expectedAttemptId
            ? { ...entry, status: t.status, completedAt: t.at, outcome: terminal ? "completed" as const : entry.outcome }
            : entry);
        const job: WorkflowJobState = {
          ...old, status: t.status, startedAt: old.startedAt ?? t.at, completedAt: terminal ? t.at : undefined,
          attempts: old.attempts + (t.attempted && !old.attemptId ? 1 : 0), error: t.error,
          attemptId: t.expectedAttemptId === undefined ? old.attemptId : undefined,
          leaseExpiresAt: t.expectedAttemptId === undefined ? old.leaseExpiresAt : undefined,
          ...(t.runId === undefined ? {} : { runId: t.runId }), ...(t.workerId === undefined ? {} : { workerId: t.workerId }),
          ...(t.outputs === undefined ? {} : { outputs: { ...old.outputs, ...t.outputs } }),
          ...(t.message === undefined ? {} : { message: t.message }), ...(t.input === undefined ? {} : { input: t.input }),
          ...(t.operation === undefined ? {} : { operation: t.operation }), ...(t.needsAttention === undefined ? {} : { needsAttention: t.needsAttention }),
          ...(t.retryAt === undefined ? {} : { retryAt: t.retryAt }), ...(history === undefined ? {} : { attemptHistory: history }),
        };
        const next = { ...run, jobs: { ...run.jobs, [jobId]: job }, updatedAt: t.at };
        this.saveWorkflow(next);
        return next;
      });
    }
    async finishWorkflowRun(i: WorkflowRunIdentity, status: "succeeded" | "failed", at: string): Promise<WorkflowRunRecord | undefined> { return this.tx(() => { const old = this.workflow(createWorkflowRunKey(i)); if (!old || old.status !== "running")
        return undefined; const v = { ...old, status, completedAt: at, updatedAt: at }; this.saveWorkflow(v); return v; }); }
    /** Marks an interrupted external invocation for inspection; it deliberately keeps the claim token so it cannot be replayed automatically. */
    async markWorkflowJobNeedsAttention(i: WorkflowRunIdentity, jobId: string, attemptId: string, at: string, message: string): Promise<WorkflowRunRecord | undefined> { return this.tx(() => { const run = this.workflow(createWorkflowRunKey(i)); const old = run?.jobs[jobId]; if (!run || !old || old.attemptId !== attemptId)
        return undefined; const job = { ...old, needsAttention: true, message, retryAt: undefined, attemptHistory: (old.attemptHistory ?? []).map(entry => entry.attemptId === attemptId ? { ...entry, status: old.status, completedAt: at, outcome: "uncertain" as const } : entry) }; const v = { ...run, jobs: { ...run.jobs, [jobId]: job }, updatedAt: at }; this.saveWorkflow(v); return v; }); }
    /** Finds expired workflow leases and makes every uncertain action visible without replaying it. */
    async markExpiredWorkflowJobClaimsNeedsAttention(at: string): Promise<WorkflowRunRecord[]> { return this.tx(() => {
        const affected: WorkflowRunRecord[] = [];
        for (const run of this.workflows()) {
            if (run.status !== "running") continue;
            let changed = false;
            const jobs = Object.fromEntries(Object.entries(run.jobs).map(([id, job]) => {
                if (!job.attemptId || !job.leaseExpiresAt || job.leaseExpiresAt > at || job.needsAttention) return [id, job];
                changed = true;
                return [id, { ...job, needsAttention: true, message: "Attempt lease expired; external outcome requires inspection.", attemptHistory: (job.attemptHistory ?? []).map(entry => entry.attemptId === job.attemptId ? { ...entry, status: job.status, completedAt: at, outcome: "uncertain" as const } : entry) }];
            }));
            if (changed) { const next = { ...run, jobs, updatedAt: at }; this.saveWorkflow(next); affected.push(next); }
        }
        return affected;
    }); }
    /** Heartbeat a live job lease without changing its attempt generation. */
    async renewWorkflowJobLease(i: WorkflowRunIdentity, jobId: string, attemptId: string, leaseExpiresAt: string, at: string): Promise<WorkflowRunRecord | undefined> { return this.tx(() => {
        const run = this.workflow(createWorkflowRunKey(i)); const job = run?.jobs[jobId];
        if (!run || !job || job.attemptId !== attemptId || job.needsAttention || run.status !== "running") return undefined;
        const next = { ...run, jobs: { ...run.jobs, [jobId]: { ...job, leaseExpiresAt } }, updatedAt: at };
        this.saveWorkflow(next);
        return next;
    }); }
    async findRunningInGroup(r: RepositoryScope, group: string): Promise<readonly WorkflowRunRecord[]> { return this.workflows().filter(v => v.status === "running" && v.concurrencyGroup === group && sameRepo(v.identity.repository, r)).sort((a, b) => a.startedAt.localeCompare(b.startedAt)); }
    async retryWorkflowJobs(i: WorkflowRunIdentity, ids: readonly string[] | undefined, at: string): Promise<WorkflowRunRecord | undefined> { return this.tx(() => { const old = this.workflow(createWorkflowRunKey(i)); if (!old)
        return undefined; const wanted = ids?.length ? new Set(ids) : undefined; const jobs = Object.fromEntries(Object.entries(old.jobs).map(([id, job]) => wanted && !wanted.has(id) || (!isTerminalJobStatus(job.status) && !job.needsAttention) ? [id, job] : [id, { ...job, status: "pending", error: undefined, message: undefined, completedAt: undefined, attemptId: undefined, needsAttention: undefined, retryAt: undefined, leaseExpiresAt: undefined, operation: undefined, runId: undefined, workerId: undefined }])); const v = { ...old, jobs, status: "running" as const, completedAt: undefined, updatedAt: at }; this.saveWorkflow(v); return v; }); }
    async listWorkflowRuns(r: RepositoryScope): Promise<readonly WorkflowRunRecord[]> { return this.workflows().filter(v => sameRepo(v.identity.repository, r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
    /** Accept a complete trigger page and its cursor in one transaction. */
    async acceptTriggerEvents(bindingId: string, events: readonly TriggerEventRecord[], cursor: JsonValue | undefined, at: string): Promise<void> {
        this.tx(() => {
            for (const event of events) {
                if (event.bindingId !== bindingId)
                    throw new Error("Trigger event bindingId must match the checkpoint binding.");
                assertJson(event.payload, "trigger event payload");
                this.db.prepare("INSERT OR IGNORE INTO trigger_events(id,binding_id,subject_key,observed_at,status,payload_json,cursor_json) VALUES(?,?,?,?,?,?,?)").run(event.id, event.bindingId, event.subjectKey, event.observedAt, event.status, JSON.stringify(event.payload), event.cursor === undefined ? null : JSON.stringify(event.cursor));
            }
            this.db.prepare("INSERT INTO trigger_checkpoints(binding_id,cursor_json,updated_at) VALUES(?,?,?) ON CONFLICT(binding_id) DO UPDATE SET cursor_json=excluded.cursor_json,updated_at=excluded.updated_at").run(bindingId, cursor === undefined ? null : JSON.stringify(cursor), at);
        });
    }
    async listPendingTriggerEvents(bindingId?: string): Promise<TriggerEventRecord[]> {
        const rows = this.db.prepare(`SELECT id,binding_id,subject_key,observed_at,status,payload_json,cursor_json FROM trigger_events WHERE status='pending'${bindingId ? " AND binding_id=?" : ""} ORDER BY observed_at,id`).all(...(bindingId ? [bindingId] : [])) as Array<{ id: string; binding_id: string; subject_key: string; observed_at: string; status: TriggerEventRecord["status"]; payload_json: string; cursor_json: string | null }>;
        return rows.map(row => ({ id: row.id, bindingId: row.binding_id, subjectKey: row.subject_key, observedAt: row.observed_at, status: row.status, payload: JSON.parse(row.payload_json) as JsonValue, ...(row.cursor_json ? { cursor: JSON.parse(row.cursor_json) as JsonValue } : {}) }));
    }
    async acknowledgeTriggerEvent(id: string, status: "accepted" | "processed"): Promise<boolean> { return this.tx(() => { const result = this.db.prepare("UPDATE trigger_events SET status=? WHERE id=? AND status='pending'").run(status, id) as { changes?: number }; return (result.changes ?? 0) === 1; }); }
    async getTriggerCheckpoint(bindingId: string): Promise<JsonValue | undefined> { const row = this.db.prepare("SELECT cursor_json FROM trigger_checkpoints WHERE binding_id=?").get(bindingId) as { cursor_json: string | null } | undefined; return row?.cursor_json ? JSON.parse(row.cursor_json) as JsonValue : undefined; }
    async enqueueProjection(topic: string, payload: unknown, at: string): Promise<void> { const encoded = JSON.stringify(payload); if (encoded === undefined)
        throw new Error("Projection payload must be JSON-serialisable data."); this.tx(() => { this.db.prepare("INSERT INTO projection_outbox(topic,payload_json,created_at) VALUES(?,?,?)").run(topic, encoded, at); }); }
    async pendingProjections(): Promise<Array<{ id: number; topic: string; payload: JsonValue; createdAt: string }>> { return (this.db.prepare("SELECT id,topic,payload_json,created_at FROM projection_outbox WHERE delivered_at IS NULL ORDER BY id").all() as Array<{ id: number; topic: string; payload_json: string; created_at: string }>).map(v => ({ id: v.id, topic: v.topic, payload: JSON.parse(v.payload_json) as JsonValue, createdAt: v.created_at })); }
    async acknowledgeProjection(id: number, at: string): Promise<boolean> { return this.tx(() => { const result = this.db.prepare("UPDATE projection_outbox SET delivered_at=? WHERE id=? AND delivered_at IS NULL").run(at, id) as { changes?: number }; return (result.changes ?? 0) === 1; }); }
}
function readLegacy(file: string): State {
    try {
        const v = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
        return { version: v.version === undefined ? 1 : v.version, runs: v.runs ?? {}, actions: v.actions ?? {}, workflows: v.workflows ?? {} } as State;
    }
    catch (error) { throw new Error(`Legacy state.json is not valid JSON and was not imported: ${error instanceof Error ? error.message : String(error)}`); }
}
function legacyHash(file: string): string { return createHash("sha256").update(readFileSync(file)).digest("hex"); }

/**
 * The importer is intentionally resumable. A live Relay leaves a lock that
 * must be respected; a process that died mid-import leaves a PID-marked lock
 * which can be recovered safely because the SQLite import transaction rolls
 * back unless its completion metadata was committed.
 */
function acquireMigrationLock(lock: string, legacyFile: string): void {
    try {
        mkdirSync(lock);
        writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        return;
    }
    catch (error) {
        if (!isStaleMigrationLock(lock))
            throw new Error(`Legacy state is busy at ${legacyFile}; stop Relay and retry migration.`);
        rmSync(lock, { recursive: true, force: true });
        try {
            mkdirSync(lock);
            writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        }
        catch {
            throw new Error(`Legacy state is busy at ${legacyFile}; stop Relay and retry migration.`);
        }
    }
}

function isStaleMigrationLock(lock: string): boolean {
    try {
        const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid?: unknown };
        if (!Number.isInteger(owner.pid) || typeof owner.pid !== "number" || owner.pid <= 0)
            return false;
        try {
            process.kill(owner.pid, 0);
            return false;
        }
        catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
    }
    catch {
        // A lock we cannot attribute to a dead Relay is treated as live.
        return false;
    }
}
/**
 * Legacy workflow records never persisted their definition. Keep their
 * original state intact, but stamp an explicit run-level hold so callers can
 * inspect it and require a deliberate definition-adoption operation.
 */
function blockUnsafeLegacyWorkflow(workflow: WorkflowRunRecord): WorkflowRunRecord {
    if (workflow.status !== "running" || workflow.definition)
        return workflow;
    return {
        ...workflow,
        // These are declared on WorkflowRunRecord during the package split.
        needsAttention: true,
        migration: {
            provenance: "legacy-json",
            reason: "definition_snapshot_missing",
            importedAt: new Date().toISOString(),
        },
    };
}
function validateLegacy(value: State): void {
    if (value.version !== 1 || !isRecord(value.runs) || !isRecord(value.actions) || !isRecord(value.workflows))
        throw new Error("Legacy state.json has an invalid ledger shape; it was not imported.");
    for (const [id, run] of Object.entries(value.runs)) {
        if (!run || run.id !== id || !run.identity?.repository?.id || !run.identity.repository.root || !run.claimedAt || !run.updatedAt)
            throw new Error(`Legacy state.json has an invalid run '${id}'; it was not imported.`);
    }
    for (const [id, action] of Object.entries(value.actions)) {
        if (!action || action.idempotencyKey !== id || !action.claimedAt || !action.updatedAt)
            throw new Error(`Legacy state.json has an invalid action '${id}'; it was not imported.`);
        assertJson(action.input, "legacy action input"); assertJson(action.output, "legacy action output"); assertJson(action.error, "legacy action error");
    }
    for (const [id, workflow] of Object.entries(value.workflows)) {
        if (!workflow || workflow.id !== id || !workflow.identity?.repository?.id || !workflow.identity.repository.root || !workflow.startedAt || !workflow.updatedAt)
            throw new Error(`Legacy state.json has an invalid workflow '${id}'; it was not imported.`);
    }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sameRepo(a: RepositoryScope, b: RepositoryScope): boolean { return a.id === b.id && a.root === b.root; }
function select(v: RunRecord[], mode: WorkerTargetSelection): RunRecord[] { const sorted = [...v].sort((a, b) => b.claimedAt.localeCompare(a.claimedAt) || b.updatedAt.localeCompare(a.updatedAt)); return mode === "active" ? sorted.filter(v => isActiveRun(v.status)) : mode === "latest" ? sorted.slice(0, 1) : sorted; }
function matchesAction(v: ActionExecutionRecord, f: ActionExecutionFilter): boolean { return (!f.triggerId || v.triggerId === f.triggerId) && (!f.actionId || v.actionId === f.actionId) && (!f.sourceId || v.sourceId === f.sourceId) && (!f.itemId || v.itemId === f.itemId) && (!f.statuses || f.statuses.includes(v.status)); }
function assertClaim(c: ActionExecutionClaimInput): void { for (const [key, value] of Object.entries({ idempotencyKey: c.idempotencyKey, triggerId: c.triggerId, actionId: c.actionId, sourceId: c.sourceId, itemId: c.itemId, claimedAt: c.claimedAt }))
    if (typeof value !== "string" || !value)
        throw new Error(`Action execution ${key} must be a non-empty string.`); assertJson(c.input, "input"); }
function assertTransition(t: ActionExecutionTransition): void { if (!["succeeded", "failed", "skipped"].includes(t.status))
    throw new Error(`Invalid action execution status: ${String(t.status)}`); if (!t.completedAt)
    throw new Error("Action execution completedAt must be a non-empty string."); assertJson(t.output, "output"); assertJson(t.error, "error"); }
function assertJson(v: unknown, name: string): asserts v is JsonValue | undefined { if (v === undefined || json(v))
    return; throw new Error(`Action execution ${name} must be JSON-serialisable data.`); }
function json(v: unknown): boolean { return v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v) || Array.isArray(v) && v.every(json) || typeof v === "object" && v !== null && Object.values(v).every(json); }

function isBusySqliteError(error: unknown): boolean {
    return typeof error === "object" && error !== null
        && "code" in error && (error as { code?: unknown }).code === "ERR_SQLITE_ERROR"
        && "errcode" in error && (error as { errcode?: unknown }).errcode === 5;
}
