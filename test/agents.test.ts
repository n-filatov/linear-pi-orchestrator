import { describe, expect, it } from "vitest";
import {
  CommandAgentLauncher,
  builtInAgentProfiles,
  builtInHarnessProfile,
  resolveAgentLaunch,
  templateValues,
  type CommandAgentProfile,
} from "../src/agents/index.js";
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
  it("ships command harnesses for Codex, Claude, Pi, and OpenCode", () => {
    expect(builtInAgentProfiles().map((profile) => profile.id)).toEqual(["codex", "claude", "pi", "opencode"]);
    expect(builtInHarnessProfile("pi")).toMatchObject({ command: "pi", modelArgument: "--model", promptDelivery: "argument" });
    expect(builtInHarnessProfile("opencode")).toMatchObject({ command: "opencode", args: ["run"], modelArgument: "--model" });
  });

  it("passes an arbitrary model string and custom prompt through a built-in harness", async () => {
    const launches: Array<{ command: string; args: readonly string[]; stdin?: string }> = [];
    const launcher = new CommandAgentLauncher({
      executor: {
        async execute(execution) {
          launches.push(execution);
          return { pid: 42 };
        },
      },
    });

    const result = await launcher.launchConfigured({
      workItem: { sourceId: "linear", id: "ENG-123", title: "Review pull request" },
      workspace: { path: "/repo/.task-relay/workspaces/ENG-123" },
      prompt: "Review PR 123 using the repository conventions.",
      overrides: { agent: "opencode", model: "gpt-5.6-terra" },
    });

    expect(result.resolved.modelId).toBe("gpt-5.6-terra");
    expect(launches).toEqual([{
      command: "opencode",
      args: ["--model", "gpt-5.6-terra", "run", "Review PR 123 using the repository conventions."],
      cwd: "/repo/.task-relay/workspaces/ENG-123",
      env: { TASK_RELAY_MODEL: "gpt-5.6-terra" },
      stdin: undefined,
      workerName: "ENG-123",
    }]);
  });

  it("starts the interactive Claude CLI without print mode and delivers the prompt to its terminal", async () => {
    const launches: Array<{ command: string; args: readonly string[]; interactiveInput?: string }> = [];
    const launcher = new CommandAgentLauncher({
      executor: {
        async execute(execution) {
          launches.push(execution);
          return { pid: 43, tmux: { session: "relay", window: "ENG-124", target: "@1" } };
        },
      },
    });

    const result = await launcher.launchConfigured({
      workItem: { sourceId: "linear", id: "ENG-124", title: "Implement feature" },
      workspace: { path: "/repo/.task-relay/workspaces/ENG-124" },
      prompt: "Implement ENG-124\n\nPreserve this multiline prompt.",
      overrides: { agent: "claude", model: "opus", promptDelivery: "interactive" },
    });

    expect(launches).toEqual([expect.objectContaining({
      command: "claude",
      args: ["--model", "opus"],
      stdin: undefined,
      interactiveInput: "Implement ENG-124\n\nPreserve this multiline prompt.",
    })]);
    expect(result.worker.metadata).toMatchObject({ interactive: true, persistent: true });
  });

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
