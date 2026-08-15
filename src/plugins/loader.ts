import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RelayPlugin } from "./contracts.js";

/** Load explicitly configured trusted plugin modules. Built-in short names never reach this function. */
export async function loadRelayPlugin(specifier: string, projectRoot: string): Promise<RelayPlugin> {
  const resolved = specifier.startsWith(".") || specifier.startsWith("/")
    ? pathToFileURL(path.resolve(projectRoot, specifier)).href
    : specifier;
  const imported = await import(resolved) as { default?: unknown; plugin?: unknown };
  const candidate = imported.default ?? imported.plugin;
  if (!isPlugin(candidate)) throw new Error(`Relay plugin '${specifier}' must export a source, action, or harness plugin as default or 'plugin'.`);
  return candidate;
}

function isPlugin(value: unknown): value is RelayPlugin {
  if (!value || typeof value !== "object") return false;
  const plugin = value as Partial<RelayPlugin>;
  return (plugin.kind === "source" || plugin.kind === "action" || plugin.kind === "harness")
    && typeof plugin.use === "string"
    && "configSchema" in plugin;
}
