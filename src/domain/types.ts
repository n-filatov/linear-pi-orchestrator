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
  continueOnError?: boolean;
}

export interface TriggerTargetDefinition {
  workers?: {
    sourceItem?: "current";
    runs?: "latest" | "active" | "all";
    workerIds?: readonly string[];
  };
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
