import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { relayConfigV2Schema } from "./v2.js";

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
