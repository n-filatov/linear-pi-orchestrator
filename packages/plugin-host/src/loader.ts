import path from "node:path";
import { pathToFileURL } from "node:url";
import { validatePluginContract, type RelayPlugin } from "@task-relay/plugin-sdk";
import { findInstalledPlugin, readPluginLock, type PluginLock } from "./store.js";

/**
 * Load an explicitly configured trusted plugin module. Built-in short names
 * never reach this function.
 *
 * Resolution order matters, and the reason is the released executable. Relay
 * ships as a `bun build --compile` binary whose module root is a virtual
 * filesystem with no `node_modules`, so `import("@scope/pkg")` can never
 * resolve there. An absolute path can. Installed plugins are therefore looked
 * up in the managed lockfile and imported by absolute path; the bare-specifier
 * import survives only as a fallback for running Relay from a checkout.
 */
export async function loadRelayPlugin(specifier: string, projectRoot: string, lock?: PluginLock): Promise<RelayPlugin> {
  const attempts: string[] = [];

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return await importPlugin(pathToFileURL(path.resolve(projectRoot, specifier)).href, specifier);
  }

  const installed = findInstalledPlugin(lock ?? await readPluginLock(), specifier);
  if (installed) {
    return await importPlugin(pathToFileURL(installed.entry).href, specifier);
  }
  attempts.push("not found in the managed plugin directory");

  try {
    return await importPlugin(specifier, specifier);
  } catch (error) {
    attempts.push(messageOf(error));
    throw new Error(
      `Could not load plugin '${specifier}'. Install it with 'relay plugin install ${specifier}', `
      + `or reference a local module path. Tried: ${attempts.join("; ")}.`,
    );
  }
}

async function importPlugin(target: string, specifier: string): Promise<RelayPlugin> {
  const imported = await import(target) as { default?: unknown; plugin?: unknown };
  const candidate = imported.default ?? imported.plugin;
  if (!isPlugin(candidate)) {
    throw new Error(`Relay plugin '${specifier}' must export a source, trigger, action, or harness plugin as default or 'plugin'.`);
  }
  validatePluginContract(candidate);
  return candidate;
}

export function isPlugin(value: unknown): value is RelayPlugin {
  if (!value || typeof value !== "object") return false;
  const plugin = value as Partial<RelayPlugin>;
  return (plugin.kind === "source" || plugin.kind === "trigger" || plugin.kind === "action" || plugin.kind === "harness")
    && typeof plugin.use === "string"
    && "configSchema" in plugin;
}

/** Loads a plugin from an absolute path, for install-time validation. */
export async function loadPluginFromEntry(entry: string): Promise<RelayPlugin> {
  return await importPlugin(pathToFileURL(path.resolve(entry)).href, entry);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}
