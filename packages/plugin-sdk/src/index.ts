import type { ZodTypeAny } from "zod";
import type {
  RepositoryScope,
  SourceEvent,
  WorkItem,
  WorkerChildSpec,
  WorkerCompletion,
  WorkerHandle,
  WorkerInputSpec,
  RunRecord,
  Workspace,
} from "@task-relay/domain";

/**
 * A Relay extension is deliberately named by configuration, rather than by a
 * TypeScript import. Built-ins use short names (for example `linear` or
 * `launch`); external implementations may use a package or local module path.
 */
export type PluginUse = string;

export type MaybePromise<T> = T | Promise<T>;

/** Current public plugin ABI. A plugin must opt into a later version explicitly. */
export const PLUGIN_SDK_API_VERSION = 1 as const;
export type PluginSdkApiVersion = typeof PLUGIN_SDK_API_VERSION;

/** A JSON-compatible value persisted at the plugin/host boundary. */
export type PluginJson = null | boolean | number | string | PluginJson[] | { [key: string]: PluginJson };
export type PluginJsonObject = { [key: string]: PluginJson };

/**
 * Outcome vocabulary for API-versioned actions. `deferred` is retryable,
 * `running` records an external operation handle, and `failed` reports a
 * handled failure without overloading a thrown infrastructure error.
 */
export type ExplicitActionOutcome<Output extends Record<string, unknown> = Record<string, unknown>> =
  | { status: "succeeded"; output?: Output; message?: string }
  | { status: "skipped"; message?: string; output?: Output }
  | { status: "deferred"; retryAt: string; reason: string; output?: Output }
  | { status: "running"; operation: PluginJsonObject; output?: Output; message?: string }
  | { status: "failed"; error: string; output?: Output; retryAt?: string };

/**
 * Safe, data-only information a client may use to present a plugin.
 *
 * Plugin code is never sent to the dashboard. A UI combines this metadata with
 * the plugin's JSON Schema to render a generic node and configuration form.
 */
export interface PluginPresentation {
  /** Human-friendly label. Defaults to the plugin's `use` identifier. */
  name: string;
  description?: string;
  /** A broad grouping such as "Workers", "Automation", or "Sources". */
  category: string;
  /** An optional icon identifier understood by the host application. */
  icon?: string;
  /** An optional CSS-compatible accent colour. */
  color?: string;
}

export interface SourcePluginContext<Config = unknown, Match = unknown> {
  sourceId: string;
  config: Config;
  match: Match;
  repository: RepositoryScope;
  signal?: AbortSignal;
  /** Compatibility adapter supplies the legacy trigger while it is migrated. */
  trigger?: import("@task-relay/domain").TriggerDefinition;
}

/**
 * A source owns both its configuration and its match vocabulary. Relay only
 * persists and passes `match` through; it must never interpret source fields
 * such as Linear labels or GitHub check conclusions.
 */
export interface SourcePlugin<Config = unknown, Match = unknown> {
  readonly kind: "source";
  readonly use: PluginUse;
  readonly configSchema: ZodTypeAny;
  readonly matchSchema: ZodTypeAny;
  readonly presentation?: PluginPresentation;
  discover(context: SourcePluginContext<Config, Match>): MaybePromise<readonly WorkItem[]>;
  matches?(item: WorkItem, match: Match, context: Omit<SourcePluginContext<Config, Match>, "match">): MaybePromise<boolean>;
  report?(event: SourceEvent, config: Config): MaybePromise<void>;
  close?(): MaybePromise<void>;
}

/** Versioned polling contract for new trigger packages. Legacy sources remain supported. */
export interface TriggerPlugin<Config = unknown, Payload extends PluginJson = PluginJson, Cursor extends PluginJson = PluginJson> {
  readonly kind: "trigger";
  readonly use: PluginUse;
  readonly apiVersion: PluginSdkApiVersion;
  readonly configSchema: import("zod").ZodType<Config>;
  readonly payloadSchema: import("zod").ZodType<Payload>;
  readonly cursorSchema: import("zod").ZodType<Cursor>;
  readonly presentation?: PluginPresentation;
  poll(context: {
    bindingId: string;
    repository: RepositoryScope;
    cursor?: Cursor;
    signal?: AbortSignal;
  }, config: Config): MaybePromise<{ events: readonly { id: string; subject: string; observedAt: string; revision?: string; payload: Payload }[]; cursor?: Cursor }>;
  close?(): MaybePromise<void>;
}

export interface WorkerTargetSelector {
  /** Select workers associated with the item which caused this trigger. */
  sourceItem?: "current";
  /** Whether a cleanup/action should see one, active, or all worker records. */
  runs?: "latest" | "active" | "all";
  /** Explicit worker ids are useful for programmatic or event-driven triggers. */
  workerIds?: readonly string[];
}

/**
 * How an action names the worker it wants to act on.
 *
 * `{ action }` is the common case inside a pipeline: it addresses the worker a
 * named earlier action created, read from that action's output. The other two
 * forms address workers that already exist, whether or not this pipeline made
 * them.
 */
export type WorkerRef =
  | { action: string }
  | { workerId: string }
  | { sourceItem: "current"; runs?: "latest" | "active" | "all" };

export interface ResolvedWorker {
  worker: WorkerHandle;
  run: RunRecord;
}

/** Verbs an action may use against workers. Launch creates; the rest address one that exists. */
export interface WorkerActions {
  launch(request: LaunchWorkerActionRequest): Promise<ActionResult>;
  cleanup(workerId: string): Promise<ActionResult>;
  /** Workers matching a reference, newest first. Empty when none match. */
  resolve(ref: WorkerRef): Promise<readonly ResolvedWorker[]>;
  /** Open a pane or window beside a running worker, in its workspace. */
  exec(ref: WorkerRef, spec: WorkerChildSpec): Promise<ActionResult>;
  /** Deliver text into a running worker's live session. */
  send(ref: WorkerRef, spec: WorkerInputSpec): Promise<ActionResult>;
  /** Read back what a worker has printed. */
  capture(ref: WorkerRef, options?: { child?: string; lines?: number }): Promise<ActionResult>;
  /** Stop a worker and its children without removing its workspace. */
  stop(ref: WorkerRef): Promise<ActionResult>;
  /** Persist data produced by an action against the selected worker generation. */
  recordOutputs(ref: WorkerRef, outputs: Record<string, unknown>): Promise<ActionResult>;
}

export interface ActionContext {
  executionId: string;
  actionId: string;
  triggerId: string;
  /** Durable ownership token for this action invocation attempt. */
  attemptId?: string;
  /** The host's advisory lease deadline for this attempt, when supported. */
  leaseExpiresAt?: string;
  repository: RepositoryScope;
  sourceId: string;
  item: WorkItem;
  /** Outputs of earlier actions in the same ordered trigger pipeline. */
  outputs: Readonly<Record<string, ActionResult>>;
  targets?: WorkerTargetSelector;
  /** Present for actions which execute once per selected worker. */
  worker?: WorkerHandle;
  run?: RunRecord;
  workers: WorkerActions;
  signal?: AbortSignal;
  /** Host already resolved typed expressions. Plugins must not template this field again. */
  inputsResolved?: boolean;
}

export interface LaunchWorkerActionRequest {
  harness: string;
  mode?: "oneshot" | "interactive";
  model?: string;
  modelProfile?: string;
  reasoningEffort?: string;
  prompt?: string;
  workspace?: Record<string, unknown>;
  /**
   * Start a background helper for a worker that another action already owns.
   * The normal one-worker-per-item guard still applies to all ordinary
   * launches, and the derived action identity still prevents duplicates.
   *
   * This is for helpers such as a Codex App Server: the helper has no terminal
   * of its own and a later action sends its UI/command into the parent worker's
   * existing terminal.
   */
  sidecar?: boolean;
  /** Harness-specific launch data that is not part of the generic worker contract. */
  harnessInput?: Record<string, unknown>;
}

/** JSON-compatible output persisted by the generic action engine. */
export interface ActionResult {
  status: "succeeded" | "skipped";
  output?: Record<string, unknown>;
  message?: string;
}

/** An action is intentionally broader than an agent launch: it may clean, notify, or mutate another system. */
export interface ActionPlugin<Config = unknown> {
  readonly kind: "action";
  readonly use: PluginUse;
  readonly configSchema: ZodTypeAny;
  readonly presentation?: PluginPresentation;
  /** Worker actions run once for each worker selected by the trigger. */
  readonly target?: "item" | "worker";
  execute(context: ActionContext, config: Config): MaybePromise<ActionResult>;
}

/**
 * Opt-in v1 action contract. It deliberately extends the legacy shape so a
 * v1 package can still be invoked by the compatibility executor while the
 * durable executor adopts the additional outcomes.
 */
export interface VersionedActionPlugin<Input = unknown, Output extends Record<string, unknown> = Record<string, unknown>>
  extends Omit<ActionPlugin<Input>, "execute"> {
  readonly apiVersion: PluginSdkApiVersion;
  readonly inputSchema: import("zod").ZodType<Input>;
  readonly outputSchema?: import("zod").ZodType<Output>;
  execute(context: ActionContext, input: Input): MaybePromise<ExplicitActionOutcome<Output>>;
  reconcile?(context: ActionContext, operation: Record<string, unknown>): MaybePromise<ExplicitActionOutcome<Output>>;
  cancel?(context: ActionContext, operation: Record<string, unknown>): MaybePromise<ExplicitActionOutcome<Output>>;
}

export type AnyActionPlugin = ActionPlugin | VersionedActionPlugin;

export interface HarnessLaunchRequest<Config = unknown> {
  workerId: string;
  repository: RepositoryScope;
  item: WorkItem;
  workspace: Workspace;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  /** Per-launch data supplied by the action that selected this harness. */
  harnessInput?: Record<string, unknown>;
  config: Config;
  signal?: AbortSignal;
}

/**
 * A harness is the adapter for a coding CLI. Model names are opaque strings:
 * the harness, not Relay's global schema, is their authority.
 */
export interface HarnessPlugin<Config = unknown> {
  readonly kind: "harness";
  readonly use: PluginUse;
  readonly configSchema: ZodTypeAny;
  readonly presentation?: PluginPresentation;
  launch(request: HarnessLaunchRequest<Config>): MaybePromise<WorkerHandle>;
  wait?(worker: WorkerHandle): MaybePromise<WorkerCompletion | undefined>;
  reconcile?(worker: WorkerHandle): MaybePromise<WorkerCompletion | undefined>;
  stop?(worker: WorkerHandle): MaybePromise<void>;
}

export type RelayPlugin = SourcePlugin | TriggerPlugin | AnyActionPlugin | HarnessPlugin;

export function isVersionedActionPlugin(plugin: RelayPlugin): plugin is VersionedActionPlugin {
  return plugin.kind === "action" && "apiVersion" in plugin;
}

/** Fail at registration with a useful error before an execution can claim work. */
export function validatePluginContract(value: RelayPlugin): void {
  const plugin = value as unknown as Record<string, unknown>;
  if (!plugin || typeof plugin !== "object") throw new Error("Plugin must be an object.");
  if (plugin.kind !== "source" && plugin.kind !== "trigger" && plugin.kind !== "action" && plugin.kind !== "harness") throw new Error("Plugin kind must be source, trigger, action, or harness.");
  if (typeof plugin.use !== "string" || plugin.use.trim().length === 0) throw new Error("Plugin use must be a non-empty string.");
  if (!isSchema(plugin.configSchema)) throw new Error(`Plugin '${plugin.use}' must provide a Zod-compatible configSchema.`);
  if (plugin.kind === "source") {
    if (!isSchema(plugin.matchSchema)) throw new Error(`Source plugin '${plugin.use}' must provide a Zod-compatible matchSchema.`);
    if (typeof plugin.discover !== "function") throw new Error(`Source plugin '${plugin.use}' must provide discover().`);
  }
  if (plugin.kind === "trigger") {
    if (plugin.apiVersion !== PLUGIN_SDK_API_VERSION) throw new Error(`Trigger plugin '${plugin.use}' uses unsupported API version '${String(plugin.apiVersion)}'.`);
    if (!isSchema(plugin.payloadSchema) || !isSchema(plugin.cursorSchema)) throw new Error(`Trigger plugin '${plugin.use}' must provide payloadSchema and cursorSchema.`);
    if (typeof plugin.poll !== "function") throw new Error(`Trigger plugin '${plugin.use}' must provide poll().`);
  }
  if (plugin.kind === "action") {
    if (typeof plugin.execute !== "function") throw new Error(`Action plugin '${plugin.use}' must provide execute().`);
    if ("apiVersion" in plugin) {
      if (plugin.apiVersion !== PLUGIN_SDK_API_VERSION) throw new Error(`Action plugin '${plugin.use}' uses unsupported API version '${String(plugin.apiVersion)}'.`);
      if (!isSchema(plugin.inputSchema)) throw new Error(`Versioned action plugin '${plugin.use}' must provide inputSchema.`);
      if (plugin.outputSchema !== undefined && !isSchema(plugin.outputSchema)) throw new Error(`Versioned action plugin '${plugin.use}' outputSchema must be Zod-compatible.`);
    }
  }
  if (plugin.kind === "harness" && typeof plugin.launch !== "function") throw new Error(`Harness plugin '${plugin.use}' must provide launch().`);
}

function isSchema(value: unknown): value is ZodTypeAny {
  return Boolean(value) && typeof value === "object" && typeof (value as { parse?: unknown }).parse === "function";
}

/** Reject values SQLite/JSON cannot faithfully persist before an outcome is stored. */
export function assertPluginJson(value: unknown, path = "value", seen = new Set<object>()): asserts value is PluginJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (Number.isFinite(value)) return; throw new Error(`${path} must be a finite number.`); }
  if (!value || typeof value !== "object") throw new Error(`${path} must be JSON-compatible.`);
  if (seen.has(value)) throw new Error(`${path} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => assertPluginJson(entry, `${path}[${index}]`, seen));
  else for (const [key, entry] of Object.entries(value)) assertPluginJson(entry, `${path}.${key}`, seen);
  seen.delete(value);
}
