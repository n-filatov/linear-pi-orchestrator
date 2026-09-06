import { zodToJsonSchema } from "zod-to-json-schema";
import type { PluginPresentation, RelayPlugin } from "@task-relay/plugin-sdk";

export type CatalogPluginKind = "source" | "trigger" | "action" | "harness";

/** Data-only plugin description safe to return from a dashboard API. */
export interface PluginCatalogEntry {
  id: string;
  kind: CatalogPluginKind;
  use: string;
  configSchema: Record<string, unknown>;
  matchSchema?: Record<string, unknown>;
  presentation: PluginPresentation;
  aliases: readonly string[];
  version?: string;
  installed?: boolean;
  health: "built-in" | "ok" | "unavailable";
  error?: string;
}

export function pluginCatalogEntry(plugin: RelayPlugin, options: {
  aliases?: readonly string[];
  version?: string;
  installed?: boolean;
  health?: PluginCatalogEntry["health"];
} = {}): PluginCatalogEntry {
  const toSchema = (schema: Parameters<typeof zodToJsonSchema>[0]) => zodToJsonSchema(schema, { $refStrategy: "none", errorMessages: false }) as Record<string, unknown>;
  const presentation = plugin.presentation ?? {
    name: plugin.use,
    description: `External ${plugin.kind} plugin.`,
    category: plugin.kind === "source" || plugin.kind === "trigger" ? "Sources" : plugin.kind === "harness" ? "Harnesses" : "Actions",
  };
  return {
    id: `${plugin.kind}:${plugin.use}`,
    kind: plugin.kind,
    use: plugin.use,
    configSchema: toSchema(plugin.configSchema),
    ...(plugin.kind === "source" ? { matchSchema: toSchema(plugin.matchSchema) } : {}),
    presentation,
    aliases: [...new Set((options.aliases ?? []).filter((alias) => alias !== plugin.use))].sort(),
    ...(options.version ? { version: options.version } : {}),
    ...(options.installed ? { installed: true } : {}),
    health: options.health ?? (options.installed ? "ok" : "built-in"),
  };
}
