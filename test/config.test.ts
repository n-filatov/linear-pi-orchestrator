import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { relayConfigSchema } from "../src/config/schema.js";

describe("Task Relay configuration", () => {
  it("validates the committed example with Linear, agent, model, and workspace adapters", () => {
    const raw = parse(readFileSync(resolve("task-relay.example.yaml"), "utf8"));
    const config = relayConfigSchema.parse(raw);
    expect(config.sources.linear.type).toBe("linear");
    expect(config.triggers.map((trigger) => trigger.agent)).toEqual(["codex", "claude"]);
    expect(config.execution.adapter).toBe("tmux");
    expect(config.workspace.adapter).toBe("wt");
  });

  it("rejects triggers that reference an unknown agent", () => {
    expect(() => relayConfigSchema.parse({
      version: 1,
      sources: { queue: { type: "command", discover: { command: "find-tasks" } } },
      agents: {},
      modelProfiles: { default: { provider: "custom", model: "default" } },
      triggers: [{ id: "ready", source: "queue", label: "ready", agent: "missing", model: "default" }],
    })).toThrow(/unknown agent/);
  });
});
