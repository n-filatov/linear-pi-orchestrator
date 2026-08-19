import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { relayConfigV2Schema, type RelayConfigV2 } from "./v2.js";

/**
 * A JSON Schema for `.task-relay.yaml`, generated from the same Zod schemas the
 * loader validates with, so editor completion can never disagree with what
 * Relay actually accepts.
 *
 * Plugin `with` blocks are deliberately `unknown` in the core schema. A caller
 * that has already resolved its plugins can pass their schemas here to have
 * their fields described too.
 */
export interface PluginSchemas {
  sources?: Readonly<Record<string, ZodTypeAny>>;
  actions?: Readonly<Record<string, ZodTypeAny>>;
  harnesses?: Readonly<Record<string, ZodTypeAny>>;
}

const schemaUrl = "https://json-schema.org/draft-07/schema#";

export function relayJsonSchema(plugins: PluginSchemas = {}): Record<string, unknown> {
  const root = zodToJsonSchema(relayConfigV2Schema, {
    name: "RelayConfig",
    $refStrategy: "none",
    errorMessages: false,
  }) as Record<string, unknown>;

  const definitions = root.definitions as Record<string, unknown> | undefined;
  const config = definitions?.RelayConfig as Record<string, unknown> | undefined;
  const target = config ?? root;

  const pluginDefinitions: Record<string, unknown> = {};
  for (const group of ["sources", "actions", "harnesses"] as const) {
    for (const [use, schema] of Object.entries(plugins[group] ?? {})) {
      // One definition per plugin, keyed so an editor can show which `use` it
      // belongs to even though the core schema keeps `with` opaque.
      pluginDefinitions[`${group}.${use}`] = zodToJsonSchema(schema, { $refStrategy: "none", errorMessages: false });
    }
  }

  return {
    $schema: schemaUrl,
    title: "Task Relay configuration",
    ...target,
    ...(Object.keys(pluginDefinitions).length > 0 ? { $defs: { plugins: pluginDefinitions } } : {}),
  };
}

/** The comment that points an editor at a written schema file. */
export function schemaDirective(path: string): string {
  return `# yaml-language-server: $schema=${path}`;
}

export interface PluginConfigSchemas {
  /** JSON Schema for each resolvable plugin's `with` block, keyed by `use`. */
  schemas: Record<string, { kind: string; schema: Record<string, unknown> }>;
  /** Plugins that could not be resolved, and why. */
  errors: Record<string, string>;
}

/**
 * Describes the `with` block of every plugin this configuration names.
 *
 * The core schema keeps `with` opaque, exactly as the engine does. This
 * resolves the plugins so a UI can render their fields without knowing anything
 * about any particular plugin — an installed plugin's configuration becomes
 * editable with no code written for it.
 *
 * A plugin that fails to load is reported rather than thrown: a config editor
 * must still open when one of several plugins is missing.
 */
export async function pluginConfigSchemas(config: RelayConfigV2, projectRoot: string): Promise<PluginConfigSchemas> {
  const { builtInActionPlugins } = await import("../actions/builtins.js");
  const { BUILT_IN_ACTIONS, BUILT_IN_HARNESSES, BUILT_IN_SOURCES } = await import("../plugins/built-ins.js");
  const { loadRelayPlugin, readPluginLock } = await import("../plugins/index.js");

  const schemas: PluginConfigSchemas["schemas"] = {};
  const errors: Record<string, string> = {};
  const describe = (use: string, kind: string, schema: ZodTypeAny) => {
    try { schemas[use] = { kind, schema: zodToJsonSchema(schema, { $refStrategy: "none", errorMessages: false }) as Record<string, unknown> }; }
    catch (error) { errors[use] = error instanceof Error ? error.message : String(error); }
  };

  for (const plugin of builtInActionPlugins()) describe(plugin.use, "action", plugin.configSchema);

  const external = new Set<string>();
  for (const source of Object.values(config.sources)) if (!BUILT_IN_SOURCES.has(source.use)) external.add(source.use);
  for (const harness of Object.values(config.harnesses)) if (!BUILT_IN_HARNESSES.has(harness.use)) external.add(harness.use);
  for (const action of Object.values(config.actions)) if (!BUILT_IN_ACTIONS.has(action.use)) external.add(action.use);
  for (const workflow of Object.values(config.workflows)) {
    for (const job of Object.values(workflow.jobs)) if (!BUILT_IN_ACTIONS.has(job.use) && !config.actions[job.use]) external.add(job.use);
  }

  const lock = external.size > 0 ? await readPluginLock() : undefined;
  for (const use of external) {
    try {
      const plugin = await loadRelayPlugin(use, projectRoot, lock);
      describe(use, plugin.kind, plugin.configSchema);
    } catch (error) {
      errors[use] = error instanceof Error ? error.message.split(".")[0] : String(error);
    }
  }
  return { schemas, errors };
}
