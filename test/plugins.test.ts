import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RelayPluginRegistry, type ActionPlugin, type HarnessPlugin, type SourcePlugin } from "../src/plugins/index.js";

describe("Relay plugin contracts", () => {
  it("keeps source matching and plugin configuration under the source provider", async () => {
    const source: SourcePlugin<{ prefix: string }, { accepted: string }> = {
      kind: "source",
      use: "example-source",
      configSchema: z.object({ prefix: z.string() }),
      matchSchema: z.object({ accepted: z.string() }),
      async discover(context) { return [{ sourceId: context.sourceId, id: "one", title: `${context.config.prefix} task` }]; },
      matches(item, match) { return item.id === match.accepted; },
    };
    const registry = new RelayPluginRegistry().registerSource(source);
    const item = (await source.discover({ sourceId: "example", config: { prefix: "Example" }, match: { accepted: "one" }, repository: { id: "repo", root: "/repo" } }))[0];
    expect(await registry.source("example-source")?.matches?.(item, { accepted: "one" }, { sourceId: "example", config: { prefix: "Example" }, repository: { id: "repo", root: "/repo" } })).toBe(true);
    expect(registry.parseSourceConfig("example-source", { prefix: "Configured" })).toEqual({ prefix: "Configured" });
    expect(() => registry.parseSourceMatch("example-source", { accepted: 1 })).toThrow();
  });

  it("registers action and harness plugins independently", () => {
    const action: ActionPlugin<{ channel: string }> = {
      kind: "action", use: "slack", configSchema: z.object({ channel: z.string() }),
      async execute() { return { status: "succeeded", output: { messageId: "m1" } }; },
    };
    const harness: HarnessPlugin = {
      kind: "harness", use: "codex", configSchema: z.unknown(),
      async launch(request) { return { id: request.workerId, startedAt: new Date(0).toISOString() }; },
    };
    const registry = new RelayPluginRegistry().registerAction(action).registerHarness(harness);
    expect(registry.action("slack")).toBe(action);
    expect(registry.harness("codex")).toBe(harness);
    expect(() => registry.registerAction(action)).toThrow(/already registered/);
  });
});
