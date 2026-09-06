import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isPlugin, RelayPluginRegistry } from "../src/index.js";

describe("plugin host registry", () => {
  it("rejects duplicate aliases before execution", () => {
    const registry = new RelayPluginRegistry();
    const plugin = { kind: "action" as const, use: "fixture", configSchema: z.object({}), execute: async () => ({ status: "succeeded" as const }) };
    registry.register(plugin);
    expect(() => registry.registerAs("fixture", { ...plugin, use: "other" })).toThrow("already registered");
  });

  it("accepts and registers a versioned trigger plugin", () => {
    const trigger = {
      kind: "trigger" as const,
      use: "fixture-trigger",
      apiVersion: 1 as const,
      configSchema: z.object({ interval: z.number().int().positive() }),
      payloadSchema: z.object({ task: z.string() }),
      cursorSchema: z.object({ since: z.string() }),
      async poll() { return { events: [] }; },
    };
    expect(isPlugin(trigger)).toBe(true);
    const registry = new RelayPluginRegistry().registerTrigger(trigger);
    expect(registry.trigger("fixture-trigger")).toBe(trigger);
    expect(registry.parseTriggerConfig("fixture-trigger", { interval: 30 })).toEqual({ interval: 30 });
  });
});
