import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { normalizeRelayConfig, relayConfigSchema, relayConfigV2Schema } from "../src/config/schema.js";
import { loadRelayConfig } from "../src/config/load.js";
import { defaultConfig } from "../src/cli/program.js";

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

  it("rejects a model profile that is incompatible with the selected agent", () => {
    expect(() => relayConfigSchema.parse({
      version: 1,
      sources: { queue: { type: "command", discover: { command: "find-tasks" } } },
      agents: { codex: { provider: "openai", command: "codex", models: ["codex-default"] } },
      modelProfiles: {
        "codex-default": { provider: "openai", model: "gpt-codex" },
        "claude-balanced": { provider: "anthropic", model: "sonnet" },
      },
      triggers: [{ id: "ready", source: "queue", label: "ready", agent: "codex", model: "claude-balanced" }],
    })).toThrow(/not allowed by agent|incompatible/);
  });

  it("accepts an explicitly allowed provider-compatible model profile", () => {
    const config = relayConfigSchema.parse({
      version: 1,
      sources: { queue: { type: "command", discover: { command: "find-tasks" } } },
      agents: { codex: { provider: "openai", command: "codex", models: ["codex-deep"], defaultModelProfile: "codex-deep" } },
      modelProfiles: { "codex-deep": { provider: "openai", model: "gpt-codex", reasoningEffort: "high" } },
      triggers: [{ id: "ready", source: "queue", label: "ready", agent: "codex", model: "codex-deep" }],
    });
    expect(config.triggers[0].model).toBe("codex-deep");
  });

  it("normalizes a v1 agent trigger into reusable v2 source, harness, and launch action definitions", () => {
    const v1 = relayConfigSchema.parse({
      version: 1,
      sources: { linear: { type: "linear" } },
      agents: { codex: { command: "codex" } },
      triggers: [{ id: "implement", source: "linear", label: "relay:implement", assignee: "me", agent: "codex", promptTemplate: "Implement {{item.id}}", workspace: { branchPrefix: "legacy-special" } }],
    });

    const config = normalizeRelayConfig(v1);
    expect(config.version).toBe(2);
    expect(config.sources.linear).toMatchObject({ use: "linear", enabled: true });
    expect(config.harnesses.codex).toMatchObject({ use: "command", with: { command: "codex" } });
    expect(config.actions["legacy.launch.implement"]).toMatchObject({ use: "launch", with: { harness: "codex", prompt: "Implement {{item.id}}" } });
    expect(config.actions["legacy.launch.implement"].with).toMatchObject({ workspace: { branchTemplate: "legacy-special/{{key}}-{{slug}}" } });
    expect(config.triggers[0]).toMatchObject({ source: "linear", match: { label: "relay:implement", assignee: "me" }, actions: ["legacy.launch.implement"] });
  });

  it("accepts ordered reusable and inline actions while retaining source-owned opaque match configuration", () => {
    const config = relayConfigV2Schema.parse({
      version: 2,
      sources: {
        github: { use: "@company/relay-github", with: { organisation: "acme", installation: 42 } },
      },
      harnesses: {
        codex: { use: "codex", with: { binary: "codex" } },
      },
      actions: {
        review: { use: "launch", with: { harness: "codex", model: "gpt-5.6-sol", prompt: "Review {{item.id}}" } },
      },
      triggers: [{
        id: "review-pr",
        source: "github",
        match: { pullRequest: { draft: false }, checks: ["failed"] },
        actions: ["review", { id: "notify", use: "./relay-plugins/slack.js", with: { channel: "agents" }, continueOnError: true }],
        targets: { workers: { sourceItem: "current", runs: "all" } },
        fire: { policy: "on-change" },
      }],
    });

    expect(config.triggers[0].match).toEqual({ pullRequest: { draft: false }, checks: ["failed"] });
    expect(config.triggers[0].actions).toHaveLength(2);
    expect(config.triggers[0].fire.policy).toBe("on-change");
    expect(config.triggers[0].targets?.workers?.runs).toBe("all");
  });

  it("rejects v2 action references that have no configured action", () => {
    expect(() => relayConfigV2Schema.parse({
      version: 2,
      sources: { queue: { use: "command" } },
      triggers: [{ id: "ready", source: "queue", match: {}, actions: ["missing"] }],
    })).toThrow(/unknown action 'missing'/);
  });

  it("loads both v1 and v2 documents as the normalized v2 configuration", async () => {
    const v1Root = await mkdtemp(join(tmpdir(), "task-relay-v1-"));
    await writeFile(join(v1Root, ".task-relay.yaml"), `version: 1\nsources:\n  queue:\n    type: command\n    discover: { command: find-tasks }\nagents:\n  codex:\n    command: codex\ntriggers:\n  - id: ready\n    source: queue\n    label: ready\n    agent: codex\n`);
    const v2Root = await mkdtemp(join(tmpdir(), "task-relay-v2-"));
    await writeFile(join(v2Root, ".task-relay.yaml"), `version: 2\nsources:\n  queue: { use: command }\nactions:\n  notify: { use: ./notify.js }\ntriggers:\n  - id: ready\n    source: queue\n    match: { priority: high }\n    actions: [notify]\n`);

    const [v1, v2] = await Promise.all([loadRelayConfig(v1Root), loadRelayConfig(v2Root)]);
    expect(v1.config.version).toBe(2);
    expect(v1.config.actions["legacy.launch.ready"]?.use).toBe("launch");
    expect(v2.config.version).toBe(2);
    expect(v2.config.triggers[0].match).toEqual({ priority: "high" });
  });

  it("builds a friendly v2 init configuration for every built-in harness name", () => {
    for (const harness of ["codex", "claude", "pi", "opencode"] as const) {
      const config = defaultConfig({ source: "linear", harness, label: "relay:implement", model: "gpt-5.6-terra", prompt: "Implement {{item.id}}", maxConcurrent: 2 }, "example", "main");
      expect(config.version).toBe(2);
      expect(config.harnesses[harness]).toEqual({ use: harness });
      expect(config.actions.implement).toMatchObject({ use: "launch", with: { harness, model: "gpt-5.6-terra" } });
      expect(config.triggers[0].actions).toEqual(["implement"]);
    }
  });
});
