import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CompositeAgentLauncher } from "../src/agents/plugin-harness.js";
import type { AgentLauncher, RepositoryScope, TriggerDefinition, WorkItem } from "../src/domain/index.js";
import type { HarnessPlugin } from "../src/plugins/index.js";

const repository: RepositoryScope = { id: "test", root: "/repo/test" };
const item: WorkItem = { sourceId: "linear", id: "NOT-337", title: "Test" };
const trigger: TriggerDefinition = { id: "workflow:codex", sourceId: "linear", repository, enabled: true };

describe("CompositeAgentLauncher", () => {
  it("preserves action-specific harness input while routing to a plugin harness", async () => {
    const commands: AgentLauncher = {
      resolve: async () => ({ agentId: "command" }),
      launch: async () => ({ id: "command-worker", startedAt: "now" }),
    };
    const harness: HarnessPlugin = {
      kind: "harness",
      use: "codex-app-server",
      configSchema: z.object({}),
      launch: async () => ({ id: "plugin-worker", startedAt: "now" }),
    };
    const launcher = new CompositeAgentLauncher(commands, [{ id: "__codex_app_server", plugin: harness, config: {} }]);

    const resolved = await launcher.resolve({
      id: "__codex_app_server",
      metadata: {
        reasoningEffort: "medium",
        harnessInput: { remoteTui: { action: "tmux.create-window-1", workerId: "tmux-worker", session: "relay", target: "@1" } },
      },
    }, item, trigger);

    expect(resolved.metadata).toMatchObject({
      harnessPlugin: "codex-app-server",
      reasoningEffort: "medium",
      harnessInput: { remoteTui: { action: "tmux.create-window-1", workerId: "tmux-worker" } },
    });
  });
});
