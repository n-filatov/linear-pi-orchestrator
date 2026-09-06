import { z } from "zod";
import { RelayPluginRegistry } from "@task-relay/plugin-host";
import type { ActionPlugin, RelayPlugin } from "@task-relay/plugin-sdk";

/** A deterministic harmless plugin for host and package integration tests. */
export function fixtureAction(use = "fixture.action"): ActionPlugin<{ value?: string }> {
  return {
    kind: "action", use, configSchema: z.object({ value: z.string().optional() }).strict(),
    async execute(_context, config) { return { status: "succeeded", output: { value: config.value ?? "fixture" } }; },
  };
}

export function registryWith(...plugins: RelayPlugin[]): RelayPluginRegistry {
  const registry = new RelayPluginRegistry();
  for (const plugin of plugins) registry.register(plugin);
  return registry;
}
