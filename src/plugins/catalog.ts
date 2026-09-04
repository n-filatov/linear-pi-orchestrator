import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { RelayConfigV2 } from "../config/v2.js";
import { builtInActionPlugins } from "../actions/builtins.js";
import { BUILT_IN_ACTIONS, BUILT_IN_HARNESSES, BUILT_IN_SOURCES } from "./built-ins.js";
import type { PluginPresentation, RelayPlugin } from "./contracts.js";
import { loadRelayPlugin } from "./loader.js";
import { readPluginLock, type InstalledPlugin, type PluginLock } from "./store.js";

export type CatalogPluginKind = "source" | "action" | "harness";

/** A data-only description for a canvas or form renderer. */
export interface PluginCatalogEntry {
  id: string;
  kind: CatalogPluginKind;
  use: string;
  /** Configuration JSON Schema. No executable plugin code is exposed. */
  configSchema: Record<string, unknown>;
  /** Source match JSON Schema, when the entry is a source plugin. */
  matchSchema?: Record<string, unknown>;
  presentation: PluginPresentation;
  /** Other configuration names that resolve to the same plugin. */
  aliases: readonly string[];
  version?: string;
  installed?: boolean;
  health: "built-in" | "ok" | "unavailable";
  error?: string;
}

export interface PluginCatalog {
  entries: readonly PluginCatalogEntry[];
}

export interface BuildPluginCatalogOptions {
  /** A project's config adds all plugins it actively references. */
  config?: RelayConfigV2;
  projectRoot: string;
  /** Defaults to true so installed plugins are discoverable before use. */
  includeInstalled?: boolean;
  /** Injectable for API tests and callers that already read the lockfile. */
  lock?: PluginLock;
}

const permissiveSchema = z.object({}).passthrough();
const invocationSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  environment: z.record(z.string()).default({}),
}).strict();
const commandSourceSchema = z.object({ discover: invocationSchema, report: invocationSchema.optional() }).strict();
const linearSourceSchema = z.object({
  mcp: z.unknown().optional(),
  tools: z.object({ listIssues: z.string().optional(), getIssue: z.string().optional(), saveIssue: z.string().optional(), saveComment: z.string().optional() }).strict().optional(),
  reporting: z.object({ runningLabel: z.string().optional(), blockedLabel: z.string().optional(), doneLabel: z.string().optional(), inProgressState: z.string().optional(), commentOnLaunch: z.boolean().optional(), commentOnFailure: z.boolean().optional() }).strict().optional(),
}).strict();
const linearMatchSchema = z.object({
  label: z.string().optional(),
  labels: z.object({ all: z.array(z.string()).optional(), any: z.array(z.string()).optional(), none: z.array(z.string()).optional() }).strict().optional(),
  statuses: z.array(z.string()).optional(), statusTypes: z.array(z.string()).optional(), assignee: z.string().optional(),
  limit: z.number().int().positive().optional(), includeArchived: z.boolean().optional(), orderBy: z.string().optional(), excludeLabels: z.array(z.string()).optional(),
}).strict();
const commandHarnessSchema = z.object({
  command: z.string().min(1).optional(), args: z.array(z.string()).optional(), interactiveArgs: z.array(z.string()).optional(),
  environment: z.record(z.string()).optional(), models: z.array(z.string()).optional(), defaultModel: z.string().optional(),
  defaultModelProfile: z.string().optional(), defaultReasoningEffort: z.string().optional(), modelArgument: z.string().optional(),
  reasoningEffortArgument: z.string().optional(), promptDelivery: z.unknown().optional(), availableWhen: z.string().optional(),
}).strict();

interface BuiltInCatalogDescription extends Omit<PluginCatalogEntry, "configSchema" | "matchSchema"> {
  configSchema: ZodTypeAny;
  matchSchema?: ZodTypeAny;
}

const builtInEntries: readonly BuiltInCatalogDescription[] = [
  {
    id: "source:linear", kind: "source", use: "linear", aliases: [], health: "built-in",
    configSchema: linearSourceSchema, matchSchema: linearMatchSchema,
    presentation: { name: "Linear", description: "Poll Linear work items through an MCP connection.", category: "Sources", icon: "linear", color: "#5e6ad2" },
  },
  {
    id: "source:command", kind: "source", use: "command", aliases: [], health: "built-in",
    configSchema: commandSourceSchema, matchSchema: permissiveSchema,
    presentation: { name: "Command source", description: "Discover canonical work items from a command.", category: "Sources", icon: "terminal", color: "#475569" },
  },
  ...["codex", "claude", "pi", "opencode", "command"].map((use): BuiltInCatalogDescription => ({
    id: `harness:${use}`, kind: "harness", use, aliases: [], health: "built-in",
    configSchema: commandHarnessSchema,
    presentation: { name: use === "command" ? "Command harness" : `${use[0].toUpperCase()}${use.slice(1)} harness`, description: "A built-in coding-worker harness.", category: "Harnesses", icon: "bot", color: "#0f766e" },
  })),
];

function toSchema(schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none", errorMessages: false }) as Record<string, unknown>;
}

function fallbackPresentation(plugin: Pick<RelayPlugin, "kind" | "use" | "presentation">): PluginPresentation {
  return plugin.presentation ?? {
    name: plugin.use,
    description: `External ${plugin.kind} plugin.`,
    category: plugin.kind === "source" ? "Sources" : plugin.kind === "harness" ? "Harnesses" : "Actions",
  };
}

function entryFor(plugin: RelayPlugin, aliases: readonly string[] = [], installed?: InstalledPlugin): PluginCatalogEntry {
  return {
    id: `${plugin.kind}:${plugin.use}`,
    kind: plugin.kind,
    use: plugin.use,
    configSchema: toSchema(plugin.configSchema),
    ...(plugin.kind === "source" ? { matchSchema: toSchema(plugin.matchSchema) } : {}),
    presentation: fallbackPresentation(plugin),
    aliases: [...new Set(aliases.filter((alias) => alias !== plugin.use))].sort(),
    ...(installed ? { version: installed.version, installed: true } : {}),
    health: installed ? "ok" : "built-in",
  };
}

function configuredExternalUses(config: RelayConfigV2): Set<string> {
  const uses = new Set<string>();
  for (const source of Object.values(config.sources)) if (!BUILT_IN_SOURCES.has(source.use)) uses.add(source.use);
  for (const harness of Object.values(config.harnesses)) if (!BUILT_IN_HARNESSES.has(harness.use)) uses.add(harness.use);
  for (const action of Object.values(config.actions)) if (!BUILT_IN_ACTIONS.has(action.use)) uses.add(action.use);
  for (const workflow of Object.values(config.workflows)) {
    for (const job of Object.values(workflow.jobs ?? {})) {
      // A job may use an action declaration, in which case its plugin is
      // already included above; otherwise its `use` is a plugin reference.
      if (!config.actions[job.use] && !BUILT_IN_ACTIONS.has(job.use)) uses.add(job.use);
    }
  }
  for (const trigger of config.triggers) {
    for (const action of trigger.actions) {
      if (typeof action !== "string" && !BUILT_IN_ACTIONS.has(action.use)) uses.add(action.use);
    }
  }
  return uses;
}

/**
 * Collect all node types Relay can safely describe. This function intentionally
 * returns JSON-compatible data only: plugin modules execute on the server to
 * expose Zod schemas, but their JavaScript never becomes dashboard code.
 */
export async function buildPluginCatalog(options: BuildPluginCatalogOptions): Promise<PluginCatalog> {
  const entries = new Map<string, PluginCatalogEntry>();
  const defaultSchema = toSchema(permissiveSchema);
  for (const entry of builtInEntries) {
    const { configSchema, matchSchema, ...description } = entry;
    entries.set(entry.id, {
      ...description,
      configSchema: toSchema(configSchema),
      ...(entry.kind === "source" ? { matchSchema: toSchema(matchSchema ?? permissiveSchema) } : {}),
    });
  }
  for (const plugin of builtInActionPlugins()) entries.set(`action:${plugin.use}`, entryFor(plugin));

  const lock = options.lock ?? await readPluginLock();
  const references = new Set(options.config ? configuredExternalUses(options.config) : []);
  if (options.includeInstalled !== false) for (const plugin of Object.values(lock.plugins)) references.add(plugin.name);

  for (const reference of references) {
    const installed = lock.plugins[reference] ?? Object.values(lock.plugins).find((candidate) => candidate.use === reference);
    try {
      const plugin = await loadRelayPlugin(reference, options.projectRoot, lock);
      const key = `${plugin.kind}:${plugin.use}`;
      const existing = entries.get(key);
      const aliases = [...(existing?.aliases ?? []), reference, ...(installed ? [installed.name, installed.use] : [])];
      entries.set(key, entryFor(plugin, aliases, installed));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const kind = installed?.kind ?? "action";
      const use = installed?.use ?? reference;
      const key = `${kind}:${use}`;
      entries.set(key, {
        id: key, kind, use, configSchema: defaultSchema,
        presentation: { name: use, description: "Plugin could not be loaded.", category: kind === "source" ? "Sources" : kind === "harness" ? "Harnesses" : "Actions" },
        aliases: [reference], ...(installed ? { version: installed.version, installed: true } : {}), health: "unavailable", error,
      });
    }
  }
  return { entries: [...entries.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.presentation.name.localeCompare(right.presentation.name)) };
}
