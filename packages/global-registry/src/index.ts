import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  RepositoryScope,
  RunRecord,
  RunStatus,
  WorkflowJobState,
  WorkflowRunRecord,
} from "@task-relay/domain";

type SqliteRunResult = { lastInsertRowid: number | bigint };
type SqliteStatement = {
  run(...values: unknown[]): SqliteRunResult;
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
};
type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
type SqliteDatabaseConstructor = new (file: string) => SqliteDatabase;

// Release artifacts run under Bun, while npm development and CI run under
// Node. Both expose the synchronous SQLite API, under different built-in
// module/class names. Keeping the specifier dynamic lets each runtime load only
// the driver it implements and avoids shipping a native dependency.
const sqliteModuleName = process.versions.bun ? "bun:sqlite" : "node:sqlite";
const sqliteModule = await import(sqliteModuleName) as Record<string, unknown>;
const RuntimeDatabase = (sqliteModule.DatabaseSync ?? sqliteModule.Database) as SqliteDatabaseConstructor;

/**
 * The global registry is deliberately separate from RepositoryStateStore.
 * RepositoryStateStore is the dispatch ledger for one checkout; this database
 * is the durable index that lets a user find a worker from another checkout.
 */
export const GLOBAL_WORKER_REGISTRY_VERSION = 4;

export type WorkerLifecycleStatus = RunStatus
  | "stopping"
  | "processes_stopped"
  | "workspace_removing"
  | "cleaned"
  | "cleanup_failed"
  | "orphaned";

export interface WorkerRuntimeHandle {
  /** Runtime-specific values are retained verbatim for forward compatibility. */
  [key: string]: unknown;
  tmuxServer?: string;
  tmuxSession?: string;
  tmuxWindow?: string;
  tmuxPane?: string;
  panePid?: number;
  processGroupId?: number;
}

export interface GlobalWorkerRecord {
  /** Stable deterministic id for one run generation, suitable for tmux tags. */
  id: string;
  repository: RepositoryScope;
  sourceId: string;
  /** Provider's stable item id. For Linear this is normally the immutable id. */
  itemId: string;
  /** Human-facing issue key, e.g. CRM-539. Defaults to itemId. */
  issueKey: string;
  triggerId: string;
  generation: string;
  runId: string;
  status: WorkerLifecycleStatus;
  snapshot: RunRecord;
  workspacePath?: string;
  branch?: string;
  harness?: string;
  runtime: WorkerRuntimeHandle;
  cleanupError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cleanedAt?: string;
}

export interface GlobalWorkerEvent {
  id: number;
  workerId: string;
  type: string;
  occurredAt: string;
  data?: Record<string, unknown>;
}

/** One local checkout known to the global control plane. */
export interface GlobalProjectFolder {
  id: string;
  repository: RepositoryScope;
  displayName?: string;
  enabled: boolean;
  configHash?: string;
  configStatus?: string;
  lastSyncedAt?: string;
  removedAt?: string;
  firstSeenAt: string;
  updatedAt: string;
}

export interface RegisterProjectFolderOptions {
  displayName?: string;
  enabled?: boolean;
  configHash?: string;
  configStatus?: string;
  lastSyncedAt?: string;
  /** Explicit registration restores a folder that was previously removed. */
  restore?: boolean;
  at?: string;
}

export interface UpdateProjectFolderOptions {
  displayName?: string | null;
  enabled?: boolean;
  configHash?: string | null;
  configStatus?: string | null;
  lastSyncedAt?: string | null;
  at?: string;
}

export interface WorkflowRunSyncOptions {
  /** Canonical local checkout to index, even for records written before repository identity migration. */
  repository?: RepositoryScope;
  /** When the global index observed this snapshot. */
  at?: string;
}

/** A denormalised workflow run suitable for global dashboard queries. */
export interface GlobalWorkflowRunRecord {
  id: string;
  projectFolderId: string;
  identity: WorkflowRunRecord["identity"];
  status: WorkflowRunRecord["status"];
  concurrencyGroup?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  timeoutAt?: string;
  snapshot: WorkflowRunRecord;
}

export interface GlobalWorkflowJobRun {
  workflowRunId: string;
  jobId: string;
  status: WorkflowJobState["status"];
  runId?: string;
  workerId?: string;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  outputs?: Record<string, unknown>;
  message?: string;
  error?: string;
}

export interface GlobalWorkflowEvent {
  id: number;
  workflowRunId: string;
  jobId?: string;
  type: string;
  occurredAt: string;
  data?: Record<string, unknown>;
}

export interface WorkflowRunListFilter {
  projectFolderId?: string;
  repository?: Pick<RepositoryScope, "id"> | string;
  repositoryId?: string;
  workflowId?: string;
  sourceId?: string;
  itemId?: string;
  statuses?: readonly WorkflowRunRecord["status"][];
  from?: string;
  to?: string;
  /** Removed folders retain history, but are hidden from normal dashboard lists. */
  includeRemoved?: boolean;
}

export interface UpsertRunOptions {
  /** Canonical repository identity (normally derived from the normalized Git remote). */
  repository?: RepositoryScope;
  /** Use this for a human issue identifier when WorkItem.id is an opaque id. */
  issueKey?: string;
  harness?: string;
  runtime?: WorkerRuntimeHandle;
  /** Lets a reconciler preserve an explicit lifecycle state over RunStatus. */
  status?: WorkerLifecycleStatus;
  at?: string;
}

export interface WorkerLookup {
  issueKey: string;
  repository?: Pick<RepositoryScope, "id"> | string;
  repositoryId?: string;
  sourceId?: string;
  includeCleaned?: boolean;
}

export interface WorkerListFilter {
  repository?: Pick<RepositoryScope, "id"> | string;
  repositoryId?: string;
  sourceId?: string;
  itemId?: string;
  issueKey?: string;
  statuses?: readonly WorkerLifecycleStatus[];
  includeCleaned?: boolean;
}

export type WorkerIssueLookup =
  | { kind: "not_found"; workers: readonly GlobalWorkerRecord[] }
  | { kind: "found"; worker: GlobalWorkerRecord; workers: readonly GlobalWorkerRecord[] }
  | { kind: "ambiguous"; workers: readonly GlobalWorkerRecord[] };

export class AmbiguousIssueKeyError extends Error {
  readonly issueKey: string;
  readonly workers: readonly GlobalWorkerRecord[];
  constructor(issueKey: string, workers: readonly GlobalWorkerRecord[]) {
    super(`Issue key '${issueKey}' is ambiguous; specify a repository or source.`);
    this.name = "AmbiguousIssueKeyError";
    this.issueKey = issueKey;
    this.workers = workers;
  }
}

export function globalWorkerRegistryPath(stateHome = defaultStateHome()): string {
  return join(stateHome, "task-relay", "registry.sqlite");
}

/**
 * SQLite-backed, process-safe registry of every worker generation known to
 * this user. It is intentionally synchronous internally: each public method
 * executes one short SQLite transaction and returns a Promise-compatible value
 * only when callers choose to await it.
 */
export class GlobalWorkerRegistry {
  readonly file: string;
  private readonly db: SqliteDatabase;

  constructor(options: { file?: string; stateHome?: string } = {}) {
    this.file = options.file ?? globalWorkerRegistryPath(options.stateHome);
    mkdirSync(dirname(this.file), { recursive: true });
    this.db = new RuntimeDatabase(this.file);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void { this.db.close(); }

  /** Registers a canonical repository even when it currently has no workers. */
  registerRepository(repository: RepositoryScope, at = new Date().toISOString()): void {
    this.transaction(() => this.upsertRepository(repository, at));
  }

  /** Upserts the current snapshot for the one stable run generation. */
  upsertRun(run: RunRecord, options: UpsertRunOptions = {}): GlobalWorkerRecord {
    const at = options.at ?? run.updatedAt;
    const repository = options.repository ?? run.identity.repository;
    const issueKey = options.issueKey ?? issueKeyFor(run);
    const itemId = stableItemIdFor(run);
    const id = workerGenerationId(run, repository.id);
    const runtime = options.runtime ?? runtimeFromRun(run);
    const status = options.status ?? statusFromRun(run);
    const harness = options.harness ?? harnessFromRun(run);
    const completedAt = run.completedAt;
    const cleanedAt = run.workspaceCleanedAt;
    const snapshot = JSON.stringify(run);
    this.transaction(() => {
      this.upsertRepository(repository, at);
      this.db.prepare(`
        INSERT INTO workers (
          id, repository_id, repository_root, source_id, item_id, issue_key, trigger_id, generation, run_id, status,
          snapshot_json, workspace_path, branch, harness, runtime_json,
          tmux_server, tmux_session, tmux_window, tmux_pane, pane_pid, process_group_id,
          cleanup_error, created_at, updated_at, completed_at, cleaned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          repository_id = excluded.repository_id,
          repository_root = excluded.repository_root,
          source_id = excluded.source_id,
          item_id = excluded.item_id,
          issue_key = excluded.issue_key,
          trigger_id = excluded.trigger_id,
          run_id = excluded.run_id,
          status = excluded.status,
          snapshot_json = excluded.snapshot_json,
          workspace_path = excluded.workspace_path,
          branch = excluded.branch,
          harness = excluded.harness,
          runtime_json = excluded.runtime_json,
          tmux_server = excluded.tmux_server,
          tmux_session = excluded.tmux_session,
          tmux_window = excluded.tmux_window,
          tmux_pane = excluded.tmux_pane,
          pane_pid = excluded.pane_pid,
          process_group_id = excluded.process_group_id,
          updated_at = excluded.updated_at,
          completed_at = COALESCE(excluded.completed_at, workers.completed_at),
          cleaned_at = COALESCE(excluded.cleaned_at, workers.cleaned_at),
          cleanup_error = CASE WHEN excluded.status = 'cleanup_failed' THEN workers.cleanup_error ELSE NULL END
      `).run(
        id, repository.id, repository.root, run.identity.sourceId, itemId, issueKey,
        run.identity.triggerId, run.claimedAt, run.id, status, snapshot,
        run.workspace?.path ?? null, run.workspace?.branch ?? null, harness ?? null, JSON.stringify(runtime),
        stringValue(runtime.tmuxServer) ?? null, stringValue(runtime.tmuxSession) ?? null, stringValue(runtime.tmuxWindow) ?? null,
        stringValue(runtime.tmuxPane) ?? null, numberValue(runtime.panePid) ?? null, numberValue(runtime.processGroupId) ?? null,
        run.claimedAt, at, completedAt ?? null, cleanedAt ?? null,
      );
    });
    return this.require(id);
  }

  /** Alias used by startup reconcilers that are syncing an existing state file. */
  syncRun(run: RunRecord, options: UpsertRunOptions = {}): GlobalWorkerRecord { return this.upsertRun(run, options); }

  /** Idempotently imports a repository state snapshot. */
  importRuns(runs: readonly RunRecord[], options: Omit<UpsertRunOptions, "issueKey"> & { issueKey?: (run: RunRecord) => string } = {}): GlobalWorkerRecord[] {
    const records: GlobalWorkerRecord[] = [];
    for (const run of runs) {
      // Importing an old JSON ledger must not overwrite handles or cleanup
      // results subsequently learned by the global reconciler. A newer local
      // snapshot (for example `relay signal`) is still authoritative.
      const repository = options.repository ?? run.identity.repository;
      const existing = this.get(workerGenerationId(run, repository.id));
      records.push(!existing || run.updatedAt > existing.updatedAt
        ? this.upsertRun(run, { ...options, issueKey: options.issueKey?.(run) })
        : existing);
    }
    return records;
  }

  /** Backward-friendly name for a caller migrating its JSON state ledger. */
  migrateRuns(runs: readonly RunRecord[], options?: Parameters<GlobalWorkerRegistry["importRuns"]>[1]): GlobalWorkerRecord[] {
    return this.importRuns(runs, options);
  }

  get(workerId: string): GlobalWorkerRecord | undefined {
    const row = this.db.prepare(`${workerSelect()} WHERE workers.id = ?`).get(workerId) as WorkerRow | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  findByRunId(runId: string): GlobalWorkerRecord | undefined {
    const row = this.db.prepare(`${workerSelect()} WHERE workers.run_id = ? ORDER BY workers.updated_at DESC LIMIT 1`).get(runId) as WorkerRow | undefined;
    return row ? recordFromRow(row) : undefined;
  }

  lookupByIssueKey(lookup: WorkerLookup): WorkerIssueLookup {
    const workers = this.list({ ...lookup, issueKey: lookup.issueKey });
    if (workers.length === 0) return { kind: "not_found", workers };
    const identities = new Set(workers.map((worker) => `${worker.repository.id}\u0000${worker.sourceId}`));
    if (identities.size > 1) return { kind: "ambiguous", workers };
    return { kind: "found", worker: workers[0]!, workers };
  }

  /** Returns a unique issue lookup or makes the caller handle ambiguity. */
  findByIssueKey(lookup: WorkerLookup): GlobalWorkerRecord | undefined {
    const result = this.lookupByIssueKey(lookup);
    if (result.kind === "ambiguous") throw new AmbiguousIssueKeyError(lookup.issueKey, result.workers);
    return result.kind === "found" ? result.worker : undefined;
  }

  list(filter: WorkerListFilter = {}): GlobalWorkerRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];
    const repositoryId = repositoryIdFrom(filter);
    if (repositoryId) { clauses.push("repository_id = ?"); values.push(repositoryId); }
    if (filter.sourceId) { clauses.push("source_id = ?"); values.push(filter.sourceId); }
    if (filter.itemId) { clauses.push("item_id = ?"); values.push(filter.itemId); }
    if (filter.issueKey) { clauses.push("issue_key = ? COLLATE NOCASE"); values.push(filter.issueKey); }
    if (filter.includeCleaned !== true) clauses.push("status <> 'cleaned'");
    if (filter.statuses?.length) {
      clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      values.push(...filter.statuses);
    }
    const sql = `${workerSelect()}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY workers.updated_at DESC, workers.generation DESC, workers.id DESC`;
    return (this.db.prepare(sql).all(...values) as WorkerRow[]).map(recordFromRow);
  }

  updateRuntimeHandle(workerId: string, runtime: WorkerRuntimeHandle, at = new Date().toISOString()): GlobalWorkerRecord | undefined {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE workers SET runtime_json = ?, tmux_server = ?, tmux_session = ?, tmux_window = ?, tmux_pane = ?,
          pane_pid = ?, process_group_id = ?, updated_at = ? WHERE id = ?
      `).run(
        JSON.stringify(runtime), stringValue(runtime.tmuxServer) ?? null, stringValue(runtime.tmuxSession) ?? null, stringValue(runtime.tmuxWindow) ?? null,
        stringValue(runtime.tmuxPane) ?? null, numberValue(runtime.panePid) ?? null, numberValue(runtime.processGroupId) ?? null, at, workerId,
      );
    });
    return this.get(workerId);
  }

  updateStatus(workerId: string, status: WorkerLifecycleStatus, options: { at?: string; cleanupError?: string; completedAt?: string; cleanedAt?: string } = {}): GlobalWorkerRecord | undefined {
    const at = options.at ?? new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE workers SET status = ?, updated_at = ?, cleanup_error = ?,
          completed_at = COALESCE(?, completed_at), cleaned_at = COALESCE(?, cleaned_at)
        WHERE id = ?
      `).run(status, at, options.cleanupError ?? null, options.completedAt ?? null, options.cleanedAt ?? (status === "cleaned" ? at : null), workerId);
    });
    return this.get(workerId);
  }

  appendEvent(workerId: string, type: string, occurredAt = new Date().toISOString(), data?: Record<string, unknown>): GlobalWorkerEvent {
    const result = this.db.prepare("INSERT INTO worker_events (worker_id, type, occurred_at, data_json) VALUES (?, ?, ?, ?)")
      .run(workerId, type, occurredAt, data === undefined ? null : JSON.stringify(data));
    return { id: Number(result.lastInsertRowid), workerId, type, occurredAt, ...(data === undefined ? {} : { data }) };
  }

  listEvents(workerId: string): GlobalWorkerEvent[] {
    const rows = this.db.prepare("SELECT id, worker_id, type, occurred_at, data_json FROM worker_events WHERE worker_id = ? ORDER BY id ASC").all(workerId) as EventRow[];
    return rows.map((row) => ({ id: Number(row.id), workerId: row.worker_id, type: row.type, occurredAt: row.occurred_at, ...(row.data_json ? { data: parseJson<Record<string, unknown>>(row.data_json, {}) } : {}) }));
  }

  private require(workerId: string): GlobalWorkerRecord {
    const record = this.get(workerId);
    if (!record) throw new Error(`Registry worker '${workerId}' disappeared during its transaction.`);
    return record;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private upsertRepository(repository: RepositoryScope, at: string): void {
    this.db.prepare(`
      INSERT INTO repositories (id, current_root, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET current_root = excluded.current_root, updated_at = excluded.updated_at
    `).run(repository.id, repository.root, at, at);
  }

  private migrate(): void {
    let current = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (current > GLOBAL_WORKER_REGISTRY_VERSION) throw new Error(`Registry schema ${current} is newer than supported schema ${GLOBAL_WORKER_REGISTRY_VERSION}.`);
    if (current === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE repositories (
            id TEXT PRIMARY KEY,
            current_root TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE workers (
            id TEXT PRIMARY KEY,
            repository_id TEXT NOT NULL REFERENCES repositories(id),
            repository_root TEXT NOT NULL,
            source_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            issue_key TEXT NOT NULL,
            trigger_id TEXT NOT NULL,
            generation TEXT NOT NULL,
            run_id TEXT NOT NULL,
            status TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            workspace_path TEXT,
            branch TEXT,
            harness TEXT,
            runtime_json TEXT NOT NULL,
            tmux_server TEXT,
            tmux_session TEXT,
            tmux_window TEXT,
            tmux_pane TEXT,
            pane_pid INTEGER,
            process_group_id INTEGER,
            cleanup_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            cleaned_at TEXT,
            UNIQUE(repository_id, source_id, item_id, trigger_id, generation)
          );
          CREATE TABLE worker_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            data_json TEXT
          );
          CREATE INDEX workers_issue_lookup ON workers(issue_key, repository_id, source_id, status, updated_at DESC);
          CREATE INDEX workers_identity_lookup ON workers(repository_id, source_id, item_id, updated_at DESC);
          CREATE INDEX workers_runtime_lookup ON workers(tmux_server, tmux_session, tmux_window, tmux_pane);
          CREATE INDEX workers_run_id_lookup ON workers(run_id, updated_at DESC);
          CREATE INDEX worker_events_worker_lookup ON worker_events(worker_id, id);
        `);
        this.db.exec("PRAGMA user_version = 2");
      });
      current = 2;
    }
    if (current === 1) {
      this.transaction(() => {
        if (!tableHasColumn(this.db, "workers", "repository_root")) this.db.exec("ALTER TABLE workers ADD COLUMN repository_root TEXT");
        this.db.exec("UPDATE workers SET repository_root = (SELECT current_root FROM repositories WHERE repositories.id = workers.repository_id)");
        this.db.exec("PRAGMA user_version = 2");
      });
      current = 2;
    }
    if (current === 2) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS project_folders (
            id TEXT PRIMARY KEY,
            repository_id TEXT NOT NULL REFERENCES repositories(id),
            root TEXT NOT NULL,
            display_name TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            config_hash TEXT,
            config_status TEXT,
            first_seen_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(repository_id, root)
          );
          CREATE TABLE IF NOT EXISTS workflow_runs (
            id TEXT PRIMARY KEY,
            project_folder_id TEXT NOT NULL REFERENCES project_folders(id) ON DELETE CASCADE,
            workflow_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            occurrence TEXT NOT NULL,
            status TEXT NOT NULL,
            concurrency_group TEXT,
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            timeout_at TEXT,
            snapshot_json TEXT NOT NULL,
            UNIQUE(project_folder_id, workflow_id, source_id, item_id, occurrence)
          );
          CREATE TABLE IF NOT EXISTS workflow_job_runs (
            workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
            job_id TEXT NOT NULL,
            status TEXT NOT NULL,
            run_id TEXT,
            worker_id TEXT,
            attempts INTEGER NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            outputs_json TEXT,
            message TEXT,
            error TEXT,
            PRIMARY KEY(workflow_run_id, job_id)
          );
          CREATE TABLE IF NOT EXISTS workflow_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
            job_id TEXT,
            type TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            data_json TEXT
          );
          CREATE INDEX IF NOT EXISTS project_folders_repository_lookup ON project_folders(repository_id, updated_at DESC);
          CREATE INDEX IF NOT EXISTS workflow_runs_folder_lookup ON workflow_runs(project_folder_id, updated_at DESC);
          CREATE INDEX IF NOT EXISTS workflow_runs_global_lookup ON workflow_runs(status, updated_at DESC);
          CREATE INDEX IF NOT EXISTS workflow_runs_identity_lookup ON workflow_runs(workflow_id, source_id, item_id, updated_at DESC);
          CREATE INDEX IF NOT EXISTS workflow_job_runs_worker_lookup ON workflow_job_runs(worker_id, workflow_run_id);
          CREATE INDEX IF NOT EXISTS workflow_events_run_lookup ON workflow_events(workflow_run_id, id);
        `);
        this.db.exec("PRAGMA user_version = 3");
      });
      current = 3;
    }
    if (current === 3) {
      this.transaction(() => {
        if (!tableHasColumn(this.db, "project_folders", "last_synced_at")) this.db.exec("ALTER TABLE project_folders ADD COLUMN last_synced_at TEXT");
        if (!tableHasColumn(this.db, "project_folders", "removed_at")) this.db.exec("ALTER TABLE project_folders ADD COLUMN removed_at TEXT");
        this.db.exec(`PRAGMA user_version = ${GLOBAL_WORKER_REGISTRY_VERSION}`);
      });
    }
  }
}

/**
 * SQLite index of repository-owned workflow executions.  This intentionally
 * does not implement WorkflowRunStore: state.json remains the dispatch ledger
 * while this registry is an independently rebuildable global read model.
 */
export class GlobalWorkflowRegistry {
  readonly file: string;
  private readonly db: SqliteDatabase;

  constructor(options: { file?: string; stateHome?: string } = {}) {
    // Keep schema ownership in one place. This also makes a workflow-only
    // dashboard bootstrap a registry created by an older Relay release.
    const bootstrap = new GlobalWorkerRegistry(options);
    this.file = bootstrap.file;
    bootstrap.close();
    this.db = new RuntimeDatabase(this.file);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("CREATE TABLE IF NOT EXISTS workflow_projection_receipts (id TEXT PRIMARY KEY)");
  }

  close(): void { this.db.close(); }

  registerProjectFolder(repository: RepositoryScope, options: RegisterProjectFolderOptions = {}): GlobalProjectFolder {
    const at = options.at ?? new Date().toISOString();
    return this.transaction(() => this.upsertProjectFolder(repository, { ...options, restore: true }, at));
  }

  /** Updates dashboard-managed metadata without touching repository-owned files. */
  updateProjectFolder(id: string, patch: UpdateProjectFolderOptions): GlobalProjectFolder | undefined {
    const at = patch.at ?? new Date().toISOString();
    return this.transaction(() => {
      const existing = this.getProjectFolder(id);
      if (!existing) return undefined;
      const displayName = patch.displayName === undefined ? existing.displayName ?? null : patch.displayName;
      const enabled = patch.enabled ?? existing.enabled;
      const configHash = patch.configHash === undefined ? existing.configHash ?? null : patch.configHash;
      const configStatus = patch.configStatus === undefined ? existing.configStatus ?? null : patch.configStatus;
      const lastSyncedAt = patch.lastSyncedAt === undefined ? existing.lastSyncedAt ?? null : patch.lastSyncedAt;
      this.db.prepare(`
        UPDATE project_folders
        SET display_name = ?, enabled = ?, config_hash = ?, config_status = ?, last_synced_at = ?, updated_at = ?
        WHERE id = ?
      `).run(displayName, enabled ? 1 : 0, configHash, configStatus, lastSyncedAt, at, id);
      return this.getProjectFolder(id);
    });
  }

  /** Unregisters a folder from normal discovery while retaining its execution history. */
  removeProjectFolder(id: string, at = new Date().toISOString()): GlobalProjectFolder | undefined {
    return this.transaction(() => {
      const existing = this.getProjectFolder(id);
      if (!existing) return undefined;
      this.db.prepare("UPDATE project_folders SET removed_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
      return this.getProjectFolder(id);
    });
  }

  getProjectFolder(id: string): GlobalProjectFolder | undefined {
    const row = this.db.prepare("SELECT * FROM project_folders WHERE id = ?").get(id) as ProjectFolderRow | undefined;
    return row ? projectFolderFromRow(row) : undefined;
  }

  findProjectFolder(repository: RepositoryScope): GlobalProjectFolder | undefined {
    const row = this.db.prepare("SELECT * FROM project_folders WHERE repository_id = ? AND root = ?").get(repository.id, repository.root) as ProjectFolderRow | undefined;
    return row ? projectFolderFromRow(row) : undefined;
  }

  listProjectFolders(options: { includeRemoved?: boolean } = {}): GlobalProjectFolder[] {
    const sql = `SELECT * FROM project_folders${options.includeRemoved ? "" : " WHERE removed_at IS NULL"} ORDER BY updated_at DESC, root ASC`;
    return (this.db.prepare(sql).all() as ProjectFolderRow[]).map(projectFolderFromRow);
  }

  /** Upserts one snapshot; an older state.json snapshot cannot regress the index. */
  syncRun(run: WorkflowRunRecord, options: WorkflowRunSyncOptions = {}): GlobalWorkflowRunRecord {
    return this.transaction(() => {
      const repository = options.repository ?? run.identity.repository;
      const observedAt = options.at ?? new Date().toISOString();
      const folder = this.upsertProjectFolder(repository, { lastSyncedAt: observedAt }, observedAt);
      const existing = this.get(run.id);
      // State.json is authoritative, but an older import must never regress a
      // more recent indexed transition. A canonical repository override is
      // still allowed to repair which checkout owns that immutable snapshot.
      if (existing && existing.updatedAt >= run.updatedAt && (existing.snapshot.revision ?? 0) >= (run.revision ?? 0)) {
        if (existing.projectFolderId !== folder.id) {
          const snapshot = { ...existing.snapshot, identity: { ...existing.snapshot.identity, repository } };
          this.db.prepare("UPDATE workflow_runs SET project_folder_id = ?, snapshot_json = ? WHERE id = ?")
            .run(folder.id, JSON.stringify(snapshot), run.id);
          return this.require(run.id);
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO workflow_runs (
          id, project_folder_id, workflow_id, source_id, item_id, occurrence, status,
          concurrency_group, started_at, updated_at, completed_at, timeout_at, snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_folder_id = excluded.project_folder_id,
          workflow_id = excluded.workflow_id,
          source_id = excluded.source_id,
          item_id = excluded.item_id,
          occurrence = excluded.occurrence,
          status = excluded.status,
          concurrency_group = excluded.concurrency_group,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          timeout_at = excluded.timeout_at,
          snapshot_json = excluded.snapshot_json
      `).run(
        run.id, folder.id, run.identity.workflowId, run.identity.sourceId, run.identity.itemId,
        run.identity.occurrence, run.status, run.concurrencyGroup ?? null, run.startedAt,
        run.updatedAt, run.completedAt ?? null, run.timeoutAt ?? null, JSON.stringify({ ...run, identity: { ...run.identity, repository } }),
      );
      this.db.prepare("DELETE FROM workflow_job_runs WHERE workflow_run_id = ?").run(run.id);
      const insertJob = this.db.prepare(`
        INSERT INTO workflow_job_runs (
          workflow_run_id, job_id, status, run_id, worker_id, attempts, started_at, completed_at,
          outputs_json, message, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [jobId, job] of Object.entries(run.jobs)) {
        insertJob.run(
          run.id, jobId, job.status, job.runId ?? null, job.workerId ?? null, job.attempts,
          job.startedAt ?? null, job.completedAt ?? null,
          job.outputs === undefined ? null : JSON.stringify(job.outputs), job.message ?? null, job.error ?? null,
        );
      }
      return this.require(run.id);
    });
  }

  /** Alias for callers importing all workflow records from state.json. */
  importRuns(runs: readonly WorkflowRunRecord[], options: WorkflowRunSyncOptions = {}): GlobalWorkflowRunRecord[] {
    return runs.map((run) => this.syncRun(run, options));
  }

  get(id: string): GlobalWorkflowRunRecord | undefined {
    const row = this.db.prepare(`${workflowRunSelect()} WHERE workflow_runs.id = ?`).get(id) as WorkflowRunRow | undefined;
    return row ? workflowRunFromRow(row) : undefined;
  }

  list(filter: WorkflowRunListFilter = {}): GlobalWorkflowRunRecord[] {
    const clauses: string[] = [];
    const values: Array<string | null> = [];
    if (!filter.includeRemoved) clauses.push("project_folders.removed_at IS NULL");
    if (filter.projectFolderId) { clauses.push("workflow_runs.project_folder_id = ?"); values.push(filter.projectFolderId); }
    const repositoryId = filter.repositoryId ?? (typeof filter.repository === "string" ? filter.repository : filter.repository?.id);
    if (repositoryId) { clauses.push("project_folders.repository_id = ?"); values.push(repositoryId); }
    if (filter.workflowId) { clauses.push("workflow_runs.workflow_id = ?"); values.push(filter.workflowId); }
    if (filter.sourceId) { clauses.push("workflow_runs.source_id = ?"); values.push(filter.sourceId); }
    if (filter.itemId) { clauses.push("workflow_runs.item_id = ?"); values.push(filter.itemId); }
    if (filter.from) { clauses.push("workflow_runs.updated_at >= ?"); values.push(filter.from); }
    if (filter.to) { clauses.push("workflow_runs.updated_at <= ?"); values.push(filter.to); }
    if (filter.statuses?.length) {
      clauses.push(`workflow_runs.status IN (${filter.statuses.map(() => "?").join(", ")})`);
      values.push(...filter.statuses);
    }
    const sql = `${workflowRunSelect()}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY workflow_runs.updated_at DESC, workflow_runs.id DESC`;
    return (this.db.prepare(sql).all(...values) as WorkflowRunRow[]).map(workflowRunFromRow);
  }

  listJobs(workflowRunId: string): GlobalWorkflowJobRun[] {
    const rows = this.db.prepare("SELECT * FROM workflow_job_runs WHERE workflow_run_id = ? ORDER BY job_id ASC").all(workflowRunId) as WorkflowJobRunRow[];
    return rows.map(workflowJobRunFromRow);
  }

  appendEvent(workflowRunId: string, type: string, occurredAt = new Date().toISOString(), data?: Record<string, unknown>, jobId?: string): GlobalWorkflowEvent {
    return this.transaction(() => {
      this.require(workflowRunId);
      const result = this.db.prepare(`
        INSERT INTO workflow_events (workflow_run_id, job_id, type, occurred_at, data_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(workflowRunId, jobId ?? null, type, occurredAt, data === undefined ? null : JSON.stringify(data));
      return { id: Number(result.lastInsertRowid), workflowRunId, ...(jobId ? { jobId } : {}), type, occurredAt, ...(data === undefined ? {} : { data }) };
    });
  }

  appendProjectedEvent(key: string, workflowRunId: string, type: string, occurredAt: string, data?: Record<string, unknown>, jobId?: string): void {
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM workflow_projection_receipts WHERE id=?").get(key)) return;
      this.require(workflowRunId);
      this.db.prepare("INSERT INTO workflow_events(workflow_run_id,job_id,type,occurred_at,data_json) VALUES(?,?,?,?,?)")
        .run(workflowRunId, jobId ?? null, type, occurredAt, data === undefined ? null : JSON.stringify(data));
      this.db.prepare("INSERT INTO workflow_projection_receipts(id) VALUES(?)").run(key);
    });
  }

  listEvents(workflowRunId: string): GlobalWorkflowEvent[] {
    const rows = this.db.prepare("SELECT * FROM workflow_events WHERE workflow_run_id = ? ORDER BY id ASC").all(workflowRunId) as WorkflowEventRow[];
    return rows.map((row) => ({
      id: Number(row.id), workflowRunId: row.workflow_run_id, ...(row.job_id ? { jobId: row.job_id } : {}),
      type: row.type, occurredAt: row.occurred_at,
      ...(row.data_json ? { data: parseJson<Record<string, unknown>>(row.data_json, {}) } : {}),
    }));
  }

  private require(id: string): GlobalWorkflowRunRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Registry workflow run '${id}' disappeared during its transaction.`);
    return record;
  }

  private upsertProjectFolder(repository: RepositoryScope, options: RegisterProjectFolderOptions, at: string): GlobalProjectFolder {
    const id = projectFolderId(repository);
    const existing = this.getProjectFolder(id);
    const displayName = options.displayName ?? existing?.displayName ?? null;
    const enabled = options.enabled ?? existing?.enabled ?? true;
    const configHash = options.configHash ?? existing?.configHash ?? null;
    const configStatus = options.configStatus ?? existing?.configStatus ?? null;
    const lastSyncedAt = options.lastSyncedAt ?? existing?.lastSyncedAt ?? null;
    this.db.prepare(`
      INSERT INTO repositories (id, current_root, first_seen_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET current_root = excluded.current_root, updated_at = excluded.updated_at
    `).run(repository.id, repository.root, at, at);
    this.db.prepare(`
      INSERT INTO project_folders (
        id, repository_id, root, display_name, enabled, config_hash, config_status, last_synced_at, removed_at, first_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repository_id = excluded.repository_id, root = excluded.root, display_name = excluded.display_name,
        enabled = excluded.enabled, config_hash = excluded.config_hash, config_status = excluded.config_status,
        last_synced_at = excluded.last_synced_at,
        removed_at = CASE WHEN ? THEN NULL ELSE project_folders.removed_at END,
        updated_at = excluded.updated_at
    `).run(id, repository.id, repository.root, displayName, enabled ? 1 : 0, configHash, configStatus, lastSyncedAt, existing?.firstSeenAt ?? at, at, options.restore ? 1 : 0);
    return this.getProjectFolder(id)!;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

type WorkerRow = {
  id: string; repository_id: string; source_id: string; item_id: string; issue_key: string; trigger_id: string; generation: string;
  run_id: string; status: WorkerLifecycleStatus; snapshot_json: string; workspace_path: string | null; branch: string | null;
  harness: string | null; runtime_json: string; cleanup_error: string | null; created_at: string; updated_at: string;
  completed_at: string | null; cleaned_at: string | null; repository_root: string | null;
};
type EventRow = { id: number | bigint; worker_id: string; type: string; occurred_at: string; data_json: string | null };
type ProjectFolderRow = {
  id: string; repository_id: string; root: string; display_name: string | null; enabled: number;
  config_hash: string | null; config_status: string | null; last_synced_at: string | null; removed_at: string | null;
  first_seen_at: string; updated_at: string;
};
type WorkflowRunRow = {
  id: string; project_folder_id: string; workflow_id: string; source_id: string; item_id: string; occurrence: string;
  status: WorkflowRunRecord["status"]; concurrency_group: string | null; started_at: string; updated_at: string;
  completed_at: string | null; timeout_at: string | null; snapshot_json: string;
};
type WorkflowJobRunRow = {
  workflow_run_id: string; job_id: string; status: WorkflowJobState["status"]; run_id: string | null; worker_id: string | null;
  attempts: number; started_at: string | null; completed_at: string | null; outputs_json: string | null; message: string | null; error: string | null;
};
type WorkflowEventRow = { id: number | bigint; workflow_run_id: string; job_id: string | null; type: string; occurred_at: string; data_json: string | null };

function recordFromRow(row: WorkerRow): GlobalWorkerRecord {
  const snapshot = parseJson<RunRecord>(row.snapshot_json, undefined as never);
  return {
    id: row.id,
    repository: { id: row.repository_id, root: row.repository_root ?? snapshot.identity.repository.root },
    sourceId: row.source_id, itemId: row.item_id, issueKey: row.issue_key, triggerId: row.trigger_id,
    generation: row.generation, runId: row.run_id, status: row.status, snapshot,
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.harness ? { harness: row.harness } : {}),
    runtime: parseJson<WorkerRuntimeHandle>(row.runtime_json, {}),
    ...(row.cleanup_error ? { cleanupError: row.cleanup_error } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.cleaned_at ? { cleanedAt: row.cleaned_at } : {}),
  };
}

function projectFolderFromRow(row: ProjectFolderRow): GlobalProjectFolder {
  return {
    id: row.id, repository: { id: row.repository_id, root: row.root }, enabled: row.enabled !== 0,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.config_hash ? { configHash: row.config_hash } : {}),
    ...(row.config_status ? { configStatus: row.config_status } : {}),
    ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}),
    ...(row.removed_at ? { removedAt: row.removed_at } : {}),
    firstSeenAt: row.first_seen_at, updatedAt: row.updated_at,
  };
}

function workflowRunFromRow(row: WorkflowRunRow): GlobalWorkflowRunRecord {
  const snapshot = parseJson<WorkflowRunRecord>(row.snapshot_json, undefined as never);
  return {
    id: row.id, projectFolderId: row.project_folder_id, identity: snapshot.identity,
    status: row.status, ...(row.concurrency_group ? { concurrencyGroup: row.concurrency_group } : {}),
    startedAt: row.started_at, updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.timeout_at ? { timeoutAt: row.timeout_at } : {}), snapshot,
  };
}

function workflowJobRunFromRow(row: WorkflowJobRunRow): GlobalWorkflowJobRun {
  return {
    workflowRunId: row.workflow_run_id, jobId: row.job_id, status: row.status, attempts: row.attempts,
    ...(row.run_id ? { runId: row.run_id } : {}), ...(row.worker_id ? { workerId: row.worker_id } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.outputs_json ? { outputs: parseJson<Record<string, unknown>>(row.outputs_json, {}) } : {}),
    ...(row.message ? { message: row.message } : {}), ...(row.error ? { error: row.error } : {}),
  };
}

/** Stable registry/tmux identifier for exactly one claimed run generation. */
export function workerGenerationId(run: RunRecord, repositoryId = run.identity.repository.id): string {
  const value = [repositoryId, run.identity.sourceId, run.identity.itemId, run.identity.triggerId, run.claimedAt].join("\u0000");
  return `wrk_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function issueKeyFor(run: RunRecord): string {
  const metadata = run.item.metadata;
  return stringValue(metadata?.issueKey) ?? stringValue(metadata?.identifier) ?? stringValue(metadata?.linearIdentifier) ?? run.item.id;
}

function stableItemIdFor(run: RunRecord): string {
  const metadata = run.item.metadata;
  return stringValue(metadata?.linearIssueId) ?? stringValue(metadata?.providerId) ?? run.identity.itemId;
}

function statusFromRun(run: RunRecord): WorkerLifecycleStatus {
  return run.workspaceCleanedAt ? "cleaned" : run.status;
}

function harnessFromRun(run: RunRecord): string | undefined {
  return stringValue(run.worker?.metadata?.harness) ?? run.agent.agentId;
}

function runtimeFromRun(run: RunRecord): WorkerRuntimeHandle {
  const metadata = run.worker?.metadata;
  const runtime = objectValue(metadata?.runtime);
  const tmux = objectValue(metadata?.tmux);
  const merged: WorkerRuntimeHandle = { ...runtime };
  if (tmux) {
    merged.tmuxServer = stringValue(tmux.server) ?? stringValue(tmux.socket) ?? merged.tmuxServer;
    merged.tmuxSession = stringValue(tmux.session) ?? merged.tmuxSession;
    merged.tmuxWindow = stringValue(tmux.window) ?? stringValue(tmux.target) ?? merged.tmuxWindow;
    merged.tmuxPane = stringValue(tmux.pane) ?? merged.tmuxPane;
  }
  merged.panePid = numberValue(metadata?.panePid) ?? numberValue(runtime?.panePid) ?? merged.panePid;
  merged.processGroupId = numberValue(metadata?.processGroupId) ?? numberValue(runtime?.processGroupId) ?? merged.processGroupId;
  return merged;
}

function defaultStateHome(): string { return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"); }
function workerSelect(): string { return "SELECT workers.* FROM workers"; }
function workflowRunSelect(): string { return "SELECT workflow_runs.* FROM workflow_runs INNER JOIN project_folders ON project_folders.id = workflow_runs.project_folder_id"; }
function projectFolderId(repository: RepositoryScope): string {
  return `fld_${createHash("sha256").update(`${repository.id}\u0000${repository.root}`).digest("hex").slice(0, 24)}`;
}
function repositoryIdFrom(filter: Pick<WorkerListFilter, "repository" | "repositoryId">): string | undefined {
  return filter.repositoryId ?? (typeof filter.repository === "string" ? filter.repository : filter.repository?.id);
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function objectValue(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
function tableHasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((entry) => entry.name === column);
}
