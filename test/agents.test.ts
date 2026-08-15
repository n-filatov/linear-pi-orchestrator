import { describe, expect, it } from "vitest";
import { resolveAgentLaunch, templateValues, type CommandAgentProfile } from "../src/agents/index.js";
import { agentProfiles } from "../src/app.js";
import { relayConfigSchema } from "../src/config/schema.js";
import type { TriggerDefinition } from "../src/domain/index.js";
import { branchForRun } from "../src/workspaces/worktree-utils.js";

const profile: CommandAgentProfile = {
  id: "codex",
  command: "codex",
  models: [
    { id: "fast", model: "fast-model", reasoningEffort: "medium" },
    { id: "deep", model: "deep-model", reasoningEffort: "high" },
  ],
  defaultModelProfile: "fast",
};

describe("agent resolution", () => {
  it("applies explicit run overrides before trigger and profile defaults", () => {
    const trigger = { id: "ready", sourceId: "queue", repository: { id: "repo", root: "/repo" }, enabled: true, agent: { id: "codex", model: "fast" } } satisfies TriggerDefinition;
    const resolved = resolveAgentLaunch({ profiles: [profile], trigger, overrides: { modelProfile: "deep", reasoningEffort: "xhigh" } });
    expect(resolved.agentId).toBe("codex");
    expect(resolved.modelId).toBe("deep-model");
    expect(resolved.reasoningEffort).toBe("xhigh");
  });

  it("renders a stable slug in workspace branch templates", () => {
    const values = templateValues({ workItem: { sourceId: "queue", id: "A-1", title: "Fix Auth Redirect!" }, workspace: { path: "/work" } });
    expect(values.slug).toBe("fix-auth-redirect");
    const run = {
      id: "run",
      identity: { repository: { id: "repo", root: "/repo" }, sourceId: "queue", itemId: "A-1", triggerId: "ready" },
      item: { sourceId: "queue", id: "A-1", title: "Fix Auth Redirect!" },
      trigger: { id: "ready", sourceId: "queue", repository: { id: "repo", root: "/repo" }, enabled: true, metadata: { branchTemplate: "relay/{{key}}-{{slug}}" } },
      agent: { agentId: "codex" },
      status: "claimed" as const,
      claimedAt: "now",
      updatedAt: "now",
    };
    expect(branchForRun(run)).toBe("relay/A-1-fix-auth-redirect");
  });

  it("only exposes allowed provider-compatible profiles to each agent", () => {
    const config = relayConfigSchema.parse({
      version: 1,
      agents: {
        codex: { provider: "openai", command: "codex", models: ["codex-deep"] },
        claude: { provider: "anthropic", command: "claude", models: ["claude-balanced"] },
      },
      modelProfiles: {
        "codex-deep": { provider: "openai", model: "gpt-codex" },
        "claude-balanced": { provider: "anthropic", model: "sonnet" },
      },
    });

    const profiles = agentProfiles(config);
    expect(profiles.find((entry) => entry.id === "codex")?.models?.map((entry) => entry.id)).toEqual(["codex-deep"]);
    expect(profiles.find((entry) => entry.id === "claude")?.models?.map((entry) => entry.id)).toEqual(["claude-balanced"]);
  });
});
