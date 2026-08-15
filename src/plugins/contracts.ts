import type { ZodTypeAny } from "zod";
import type {
  RepositoryScope,
  SourceEvent,
  WorkItem,
  WorkerCompletion,
  WorkerHandle,
  RunRecord,
  Workspace,
} from "../domain/index.js";

/**
 * A Relay extension is deliberately named by configuration, rather than by a
 * TypeScript import. Built-ins use short names (for example `linear` or
 * `launch`); external implementations may use a package or local module path.
 */
export type PluginUse = string;

export type MaybePromise<T> = T | Promise<T>;

export interface SourcePluginContext<Config = unknown, Match = unknown> {
  sourceId: string;
  config: Config;
  match: Match;
  repository: RepositoryScope;
  signal?: AbortSignal;
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
  discover(context: SourcePluginContext<Config, Match>): MaybePromise<readonly WorkItem[]>;
  matches?(item: WorkItem, match: Match, context: Omit<SourcePluginContext<Config, Match>, "match">): MaybePromise<boolean>;
  report?(event: SourceEvent, config: Config): MaybePromise<void>;
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

export interface ActionContext {
  executionId: string;
  actionId: string;
  triggerId: string;
  repository: RepositoryScope;
  sourceId: string;
  item: WorkItem;
  /** Outputs of earlier actions in the same ordered trigger pipeline. */
  outputs: Readonly<Record<string, ActionResult>>;
  targets?: WorkerTargetSelector;
  /** Present for actions which execute once per selected worker. */
  worker?: WorkerHandle;
  run?: RunRecord;
  workers: {
    launch(request: LaunchWorkerActionRequest): Promise<ActionResult>;
    cleanup(workerId: string): Promise<ActionResult>;
  };
  signal?: AbortSignal;
}

export interface LaunchWorkerActionRequest {
  harness: string;
  mode?: "oneshot" | "interactive";
  model?: string;
  modelProfile?: string;
  prompt?: string;
  workspace?: Record<string, unknown>;
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
  /** Worker actions run once for each worker selected by the trigger. */
  readonly target?: "item" | "worker";
  execute(context: ActionContext, config: Config): MaybePromise<ActionResult>;
}

export interface HarnessLaunchRequest<Config = unknown> {
  workerId: string;
  repository: RepositoryScope;
  item: WorkItem;
  workspace: Workspace;
  prompt: string;
  model?: string;
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
  launch(request: HarnessLaunchRequest<Config>): MaybePromise<WorkerHandle>;
  wait?(worker: WorkerHandle): MaybePromise<WorkerCompletion | undefined>;
  reconcile?(worker: WorkerHandle): MaybePromise<WorkerCompletion | undefined>;
  stop?(worker: WorkerHandle): MaybePromise<void>;
}

export type RelayPlugin = SourcePlugin | ActionPlugin | HarnessPlugin;

/** In-memory registry used by built-ins today and dynamic module loading later. */
export class RelayPluginRegistry {
  private readonly sources = new Map<PluginUse, SourcePlugin>();
  private readonly actions = new Map<PluginUse, ActionPlugin>();
  private readonly harnesses = new Map<PluginUse, HarnessPlugin>();

  register(plugin: RelayPlugin, alias: PluginUse = plugin.use): this {
    const collection = plugin.kind === "source" ? this.sources : plugin.kind === "action" ? this.actions : this.harnesses;
    if (collection.has(alias)) throw new Error(`A ${plugin.kind} plugin named '${alias}' is already registered.`);
    collection.set(alias, plugin as never);
    return this;
  }

  registerSource(plugin: SourcePlugin): this { return this.register(plugin); }
  registerAction(plugin: ActionPlugin): this { return this.register(plugin); }
  registerHarness(plugin: HarnessPlugin): this { return this.register(plugin); }
  registerAs(alias: PluginUse, plugin: RelayPlugin): this { return this.register(plugin, alias); }

  source(use: PluginUse): SourcePlugin | undefined { return this.sources.get(use); }
  action(use: PluginUse): ActionPlugin | undefined { return this.actions.get(use); }
  harness(use: PluginUse): HarnessPlugin | undefined { return this.harnesses.get(use); }

  /** Validate the previously-opaque `with` only after its plugin is known. */
  parseSourceConfig(use: PluginUse, value: unknown): unknown {
    const plugin = this.source(use);
    if (!plugin) throw new Error(`Unknown source plugin '${use}'.`);
    return plugin.configSchema.parse(value);
  }

  parseSourceMatch(use: PluginUse, value: unknown): unknown {
    const plugin = this.source(use);
    if (!plugin) throw new Error(`Unknown source plugin '${use}'.`);
    return plugin.matchSchema.parse(value);
  }

  parseActionConfig(use: PluginUse, value: unknown): unknown {
    const plugin = this.action(use);
    if (!plugin) throw new Error(`Unknown action plugin '${use}'.`);
    return plugin.configSchema.parse(value);
  }

  parseHarnessConfig(use: PluginUse, value: unknown): unknown {
    const plugin = this.harness(use);
    if (!plugin) throw new Error(`Unknown harness plugin '${use}'.`);
    return plugin.configSchema.parse(value);
  }

  list(): readonly RelayPlugin[] {
    return [...this.sources.values(), ...this.actions.values(), ...this.harnesses.values()];
  }
}
