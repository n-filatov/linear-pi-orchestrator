/** A stable identifier for the repository in which a relay is running. */
export interface RepositoryScope {
  /** A configuration-safe identifier; it should be stable across process restarts. */
  id: string;
  /** Absolute repository root, retained for workspace provisioning and auditability. */
  root: string;
}

export type WorkItemState = "open" | "active" | "terminal" | "unknown";

/**
 * Source-neutral work that can be dispatched to an agent.
 *
 * Sources may put provider-specific fields in `metadata`; orchestration decisions
 * must use the canonical fields above it.
 */
export interface WorkItem {
  sourceId: string;
  id: string;
  title: string;
  description?: string;
  url?: string;
  state?: WorkItemState;
  /** Set by the source when no more work should be performed for this item. */
  terminal?: boolean;
  metadata?: Record<string, unknown>;
  /** Durable occurrence supplied by a versioned trigger adapter. */
  triggerEvent?: { id: string; payload: unknown };
}

export interface AgentProfile {
  /** The launcher-specific agent profile to request. */
  id: string;
  /** A requested model. The launcher remains the authority for resolution. */
  model?: string;
  promptTemplate?: string;
  metadata?: Record<string, unknown>;
}

/** What was requested and what the launcher actually selected for a run. */
export interface AgentResolution {
  requestedAgentId?: string;
  requestedModel?: string;
  agentId: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

/** A configurable rule that makes work from one source eligible to run. */
export interface TriggerDefinition {
  id: string;
  sourceId: string;
  repository: RepositoryScope;
  enabled: boolean;
  /** Source-owned matching configuration, e.g. a Linear label or command arguments. */
  selector?: Record<string, unknown>;
  /** Maximum active runs for this trigger. Defaults are supplied by the caller. */
  maxConcurrent?: number;
  agent?: AgentProfile;
  /** Optional agent-launcher overrides retained at the domain boundary. */
  model?: string;
  modelProfile?: string;
  reasoningEffort?: string;
  promptDelivery?: "stdin" | "argument" | "file" | "interactive";
  metadata?: Record<string, unknown>;
  /** Ordered, source-neutral actions executed when this trigger matches. */
  actions?: readonly TriggerActionDefinition[];
  targets?: TriggerTargetDefinition;
  firePolicy?: "once-per-match" | "once-per-item" | "on-change" | "every-poll";
}

export interface TriggerActionDefinition {
  id: string;
  use: string;
  config?: unknown;
  /** Optional condition retained when an ordered action is normalized to a job. */
  if?: string;
  continueOnError?: boolean;
}

export interface TriggerTargetDefinition {
  workers?: {
    sourceItem?: "current";
    runs?: "latest" | "active" | "all";
    workerIds?: readonly string[];
  };
}

export type FirePolicy = "once-per-match" | "once-per-item" | "on-change" | "every-poll";

/**
 * The state of one job inside a workflow run.
 *
 * `started` is the state GitHub Actions has no need for and Relay cannot do
 * without: a job that launched an agent which is still running. A dev-server
 * pane depends on the agent having started; a review job depends on it having
 * finished. Those are different edges, so they need different states.
 */
export type WorkflowJobStatus =
  | "pending"
  | "started"
  | "succeeded"
  | "failed"
  | "skipped"
  | "omitted";

/** One dependency edge. An absent status means `succeeded` or `skipped`, as in Argo. */
export interface WorkflowNeed {
  job: string;
  status?: "started" | "succeeded" | "failed" | "skipped";
}

export interface WorkflowJobDefinition {
  id: string;
  use: string;
  config?: unknown;
  needs?: readonly WorkflowNeed[];
  /** GitHub Actions expression. Defaults to `success()` when omitted. */
  if?: string;
  continueOnError?: boolean;
  /**
   * The name this job was declared under. A matrix job expands into several
   * instances that share one group, so `needs: implement` can mean "every
   * instance of implement" without the author naming them.
   */
  group?: string;
  /** Matrix values bound to this instance, exposed to `${{ matrix.* }}`. */
  matrix?: Record<string, unknown>;
  /** Milliseconds after which this job alone is failed. */
  timeoutMs?: number;
}

/** At most one run per group is live at a time. */
export interface WorkflowConcurrency {
  /** Rendered per item, so a group may be workflow-wide or per-ticket. */
  group: string;
  /** Stop the older run rather than skipping the new one. */
  cancelInProgress: boolean;
}

/** A named, ordered set of jobs evaluated for every item its source matches. */
export interface WorkflowDefinition {
  id: string;
  sourceId: string;
  repository: RepositoryScope;
  enabled: boolean;
  /** Source-owned matching configuration, opaque to the engine. */
  selector?: Record<string, unknown>;
  firePolicy?: FirePolicy;
  maxConcurrent?: number;
  targets?: TriggerTargetDefinition;
  metadata?: Record<string, unknown>;
  /** Milliseconds after which a run with unsatisfiable jobs is failed. */
  timeoutMs?: number;
  concurrency?: WorkflowConcurrency;
  /** Declaration order. `needs` refines it; it does not replace it. */
  jobs: readonly WorkflowJobDefinition[];
}

export interface WorkflowJobState {
  status: WorkflowJobStatus;
  /** Unique ownership token for the current invocation; survives process death. */
  attemptId?: string;
  /** Claim lease for this attempt; expiry alone never authorizes an unsafe repeat. */
  leaseExpiresAt?: string;
  /** Durable attempt trail used to reconcile an uncertain external effect. */
  attemptHistory?: Array<{
    attemptId: string;
    claimedAt: string;
    completedAt?: string;
    status?: WorkflowJobStatus;
    outcome?: "completed" | "uncertain";
  }>;
  /** Resolved input is retained across retries. */
  input?: unknown;
  needsAttention?: boolean;
  retryAt?: string;
  operation?: Record<string, unknown>;
  /** Set when this job launched a worker. */
  runId?: string;
  workerId?: string;
  outputs?: Record<string, unknown>;
  message?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
}

export interface WorkflowRunIdentity {
  repository: RepositoryScope;
  workflowId: string;
  sourceId: string;
  itemId: string;
  /** Separates reruns of one workflow for one item; derived from the fire policy. */
  occurrence: string;
}

export interface WorkflowRunRecord {
  revision?: number;
  id: string;
  identity: WorkflowRunIdentity;
  item: WorkItem;
  /** Immutable definition used by this run, including after config edits. */
  definition?: WorkflowDefinition;
  status: "running" | "succeeded" | "failed";
  jobs: Record<string, WorkflowJobState>;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Absolute deadline. A run that passes it is failed rather than left pending. */
  timeoutAt?: string;
  /** Rendered concurrency group, so live runs can be compared without the config. */
  concurrencyGroup?: string;
  /** A migrated or uncertain run must be reviewed before any new external effect. */
  needsAttention?: boolean;
  /** Provenance retained when a legacy JSON record has no immutable definition snapshot. */
  migration?: {
    provenance: "legacy-json";
    reason: string;
    importedAt: string;
  };
}

/** A narrow, generation-safe patch applied to one job inside one run. */
export interface WorkflowJobTransition {
  status: WorkflowJobStatus;
  expectedAttemptId?: string;
  input?: unknown;
  needsAttention?: boolean;
  retryAt?: string;
  operation?: Record<string, unknown>;
  runId?: string;
  workerId?: string;
  outputs?: Record<string, unknown>;
  message?: string;
  error?: string;
  at: string;
  /** Count this evaluation as an attempt. */
  attempted?: boolean;
}

export interface WorkflowRunStore {
  /** Returns the open run for this identity, creating it when none exists. */
  openWorkflowRun(input: { identity: WorkflowRunIdentity; item: WorkItem; startedAt: string; timeoutAt?: string; concurrencyGroup?: string; definition?: WorkflowDefinition }): Promise<WorkflowRunRecord>;
  /** Atomically owns a pending job before any external effect. */
  claimWorkflowJob?(identity: WorkflowRunIdentity, jobId: string, claim: { at: string; attemptId: string; input?: unknown; leaseExpiresAt?: string }): Promise<WorkflowRunRecord | undefined>;
  /** Live runs sharing a concurrency group, so a new one can yield or cancel. */
  findRunningInGroup(repository: RepositoryScope, group: string): Promise<readonly WorkflowRunRecord[]>;
  /** Clears terminal job states so a run can be advanced again. */
  retryWorkflowJobs(identity: WorkflowRunIdentity, jobIds: readonly string[] | undefined, at: string): Promise<WorkflowRunRecord | undefined>;
  findWorkflowRun(identity: WorkflowRunIdentity): Promise<WorkflowRunRecord | undefined>;
  /** Highest occurrence recorded for a workflow and item, used to open a rerun. */
  latestWorkflowRun(identity: Omit<WorkflowRunIdentity, "occurrence">): Promise<WorkflowRunRecord | undefined>;
  updateWorkflowJob(identity: WorkflowRunIdentity, jobId: string, transition: WorkflowJobTransition): Promise<WorkflowRunRecord | undefined>;
  finishWorkflowRun(identity: WorkflowRunIdentity, status: "succeeded" | "failed", completedAt: string): Promise<WorkflowRunRecord | undefined>;
  listWorkflowRuns(repository: RepositoryScope): Promise<readonly WorkflowRunRecord[]>;
}

/** Optional recovery capabilities supplied by a durable execution ledger. */
export interface WorkflowAttemptRecoveryStore {
  /** Keeps a live attempt lease valid only when the caller owns its generation. */
  renewWorkflowJobLease?(identity: WorkflowRunIdentity, jobId: string, attemptId: string, leaseExpiresAt: string, at: string): Promise<WorkflowRunRecord | undefined>;
  /** Surfaces expired effects for inspection without retrying them. */
  markExpiredWorkflowJobClaimsNeedsAttention?(at: string): Promise<WorkflowRunRecord[]>;
  /** Records an uncertain operation while retaining its ownership generation. */
  markWorkflowJobNeedsAttention?(identity: WorkflowRunIdentity, jobId: string, attemptId: string, at: string, message: string): Promise<WorkflowRunRecord | undefined>;
}

/** A reversible key for one workflow run. */
export function createWorkflowRunKey(identity: WorkflowRunIdentity): string {
  return JSON.stringify([
    identity.repository.id,
    identity.repository.root,
    identity.workflowId,
    identity.sourceId,
    identity.itemId,
    identity.occurrence,
  ]);
}

export function isTerminalJobStatus(status: WorkflowJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped" || status === "omitted";
}

/** Whether a need is met, still reachable, or permanently impossible. */
export function needSatisfaction(need: WorkflowNeed, state: WorkflowJobState | undefined): "met" | "waiting" | "impossible" {
  const status = state?.status ?? "pending";
  const wanted = need.status;
  if (!wanted) {
    if (status === "succeeded" || status === "skipped") return "met";
    if (status === "failed" || status === "omitted") return "impossible";
    return "waiting";
  }
  if (status === wanted) return "met";
  // A job passes through each state once. Once it is terminal it can never
  // reach a different status, so a dependency on one is impossible rather than
  // merely unmet. `pending` and `started` can both still advance.
  return isTerminalJobStatus(status) ? "impossible" : "waiting";
}

/** All dimensions that make a dispatch unique. */
export interface RunIdentity {
  repository: RepositoryScope;
  sourceId: string;
  itemId: string;
  triggerId: string;
}

export type RunStatus =
  | "claimed"
  | "provisioning"
  | "launching"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped";

export interface Workspace {
  path: string;
  branch?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerHandle {
  id: string;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

/** Where a worker-scoped command opens: beside the agent, or in its own window. */
export type WorkerOpenTarget = "pane" | "window";

export interface WorkerChildSpec {
  command: string;
  args?: readonly string[];
  /** Defaults to the worker's workspace directory. */
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Window name, or pane title when the runtime supports one. */
  name?: string;
  open: WorkerOpenTarget;
  /** Split direction for a pane. Ignored when opening a window. */
  direction?: "horizontal" | "vertical";
}

/**
 * A process Relay started beside an existing worker. Children are persisted on
 * the worker handle so that stop and cleanup can account for every window and
 * pane Relay opened, not only the one the agent runs in.
 */
export interface WorkerChildHandle {
  id: string;
  kind: WorkerOpenTarget;
  /** Runtime-specific address, such as a tmux pane or window id. */
  target: string;
  name?: string;
  command: string;
  startedAt: string;
}

export interface WorkerInputSpec {
  text: string;
  /** Submit the text after pasting it. Defaults to true. */
  submit?: boolean;
  /** Address a child opened by `open` instead of the worker's own pane. */
  child?: string;
}

export interface WorkerRuntimeCapabilities {
  /** Can open additional panes or windows beside a running worker. */
  children: boolean;
  /** Can deliver text into a live worker session. */
  input: boolean;
  /** Can read back a worker's visible output. */
  capture: boolean;
}

/**
 * Control over an already-running worker. This is deliberately separate from
 * launching one: an action may need to open a dev server beside an agent, send
 * it a new instruction, or read what it printed, long after it started.
 */
export interface WorkerRuntime {
  readonly capabilities: WorkerRuntimeCapabilities;
  open(worker: WorkerHandle, spec: WorkerChildSpec): Promise<WorkerChildHandle>;
  sendInput(worker: WorkerHandle, spec: WorkerInputSpec): Promise<void>;
  capture(worker: WorkerHandle, options?: { child?: string; lines?: number }): Promise<string>;
  exists(worker: WorkerHandle, child?: string): Promise<boolean>;
  closeChild(worker: WorkerHandle, child: WorkerChildHandle): Promise<void>;
}

/** Children Relay opened beside a worker, read from its persisted metadata. */
export function workerChildren(worker: WorkerHandle | undefined): readonly WorkerChildHandle[] {
  const value = worker?.metadata?.children;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is WorkerChildHandle =>
    entry !== null && typeof entry === "object"
    && typeof (entry as WorkerChildHandle).id === "string"
    && typeof (entry as WorkerChildHandle).target === "string");
}

/** The terminal result observed for a worker after it has been launched. */
export interface WorkerCompletion {
  status: "succeeded" | "failed";
  error?: string;
}

/** Durable lifecycle state for a dispatched work item. */
export interface RunRecord {
  /** Deterministic serialized form of `identity`; generated with createRunKey. */
  id: string;
  identity: RunIdentity;
  item: WorkItem;
  trigger: TriggerDefinition;
  /** Requested and resolved agent/model details, retained for auditability. */
  agent: AgentResolution;
  status: RunStatus;
  claimedAt: string;
  updatedAt: string;
  workspace?: Workspace;
  worker?: WorkerHandle;
  /** Set after the persisted workspace has been safely removed. */
  workspaceCleanedAt?: string;
  completedAt?: string;
  error?: string;
}

export type SourceEventType =
  | "claimed"
  | "provisioning"
  | "launched"
  | "succeeded"
  | "failed"
  | "stopped";

/** Lifecycle information sent back to a source without exposing orchestrator internals. */
export interface SourceEvent {
  type: SourceEventType;
  sourceId: string;
  run: RunRecord;
  occurredAt: string;
  message?: string;
  error?: string;
}

export interface DiscoverWorkOptions {
  trigger: TriggerDefinition;
  signal?: AbortSignal;
}

export interface WorkSource {
  readonly id: string;
  discover(options: DiscoverWorkOptions): Promise<readonly WorkItem[]>;
  report(event: SourceEvent): Promise<void>;
  acknowledge?(item: WorkItem): Promise<void>;
  close?(): Promise<void>;
}

export interface RunClaim {
  id: string;
  identity: RunIdentity;
  item: WorkItem;
  trigger: TriggerDefinition;
  agent: AgentResolution;
  claimedAt: string;
  /** Enforced by the store while it holds its cross-process lock. */
  maxConcurrent: number;
}

/** A terminal transition that must apply to one specific active run generation. */
export interface RunTerminalTransition {
  status: "succeeded" | "failed" | "stopped";
  completedAt: string;
  error?: string;
}

export interface RunStore {
  findActive(identity: RunIdentity): Promise<RunRecord | undefined>;
  countActive(identity: Pick<RunIdentity, "repository" | "sourceId" | "triggerId">): Promise<number>;
  /** Atomically creates a claimed run, or returns undefined when another process won. */
  claim(claim: RunClaim): Promise<RunRecord | undefined>;
  /** Atomically terminally transitions an active run only if its generation still matches. */
  finishActive(identity: RunIdentity, claimedAt: string, transition: RunTerminalTransition): Promise<RunRecord | undefined>;
  /** Atomically records workspace removal without changing the run's terminal result. */
  markWorkspaceCleaned(identity: RunIdentity, claimedAt: string, cleanedAt: string): Promise<RunRecord | undefined>;
  /**
   * Atomically appends a child Relay opened beside a worker. This must not be a
   * read-modify-write of the whole record: a worker can reach a terminal status
   * while a pane is being opened for it, and that result must survive.
   */
  recordWorkerChild?(identity: RunIdentity, claimedAt: string, child: WorkerChildHandle, recordedAt: string): Promise<RunRecord | undefined>;
  /**
   * Atomically merges outputs an agent reported for itself. Recorded before the
   * run is finished, so a workflow job that reads `needs.<job>.outputs` never
   * observes a completed job with its outputs missing.
   */
  recordWorkerOutputs?(identity: RunIdentity, claimedAt: string, outputs: Record<string, unknown>, recordedAt: string): Promise<RunRecord | undefined>;
  update(run: RunRecord): Promise<void>;
  listActive?(repository: RepositoryScope): Promise<readonly RunRecord[]>;
  /** Find workers created for a source item, regardless of the trigger that launched them. */
  findRunsForItem?(query: {
    repository: RepositoryScope;
    sourceId: string;
    itemId: string;
    selection?: "latest" | "active" | "all";
    includeCleaned?: boolean;
  }): Promise<readonly RunRecord[]>;
  findWorkerTargets?(query: {
    repository: RepositoryScope;
    sourceId?: string;
    itemId?: string;
    selection?: "latest" | "active" | "all";
    workerIds?: readonly string[];
    includeCleaned?: boolean;
  }): Promise<readonly RunRecord[]>;
}

export interface AgentLaunchSpec {
  run: RunRecord;
  item: WorkItem;
  trigger: TriggerDefinition;
  workspace: Workspace;
  agent: AgentResolution;
  signal?: AbortSignal;
}

export interface AgentLauncher {
  resolve(profile: AgentProfile | undefined, item: WorkItem, trigger: TriggerDefinition): Promise<AgentResolution>;
  launch(spec: AgentLaunchSpec): Promise<WorkerHandle>;
  /** Control over already-running workers. Undefined when the adapter cannot provide it. */
  readonly runtime?: WorkerRuntime;
  /** Wait for a locally launched worker. Undefined means this launcher cannot observe exits. */
  wait?(worker: WorkerHandle, run: RunRecord): Promise<WorkerCompletion | undefined>;
  /** Check a persisted worker after a relay process has restarted. */
  reconcile?(worker: WorkerHandle, run: RunRecord): Promise<WorkerCompletion | undefined>;
  stop?(worker: WorkerHandle, run: RunRecord): Promise<void>;
}

export interface WorkspaceProvider {
  provision(run: RunRecord, signal?: AbortSignal): Promise<Workspace>;
  cleanup?(workspace: Workspace, run: RunRecord): Promise<void>;
}

export interface RelayLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** A reversible, unambiguous key suitable for stores that need a single run id. */
export function createRunKey(identity: RunIdentity): string {
  return JSON.stringify([
    identity.repository.id,
    identity.repository.root,
    identity.sourceId,
    identity.itemId,
    identity.triggerId,
  ]);
}

export function isActiveRun(status: RunStatus): boolean {
  return status === "claimed" || status === "provisioning" || status === "launching" || status === "running";
}

export function isTerminalWorkItem(item: WorkItem): boolean {
  return item.terminal === true || item.state === "terminal";
}
