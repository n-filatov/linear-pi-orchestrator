import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CompositeAgentLauncher } from "../src/agents/plugin-harness.js";
import type { AgentLauncher, RepositoryScope, RunRecord, TriggerDefinition, WorkItem } from "../src/domain/index.js";
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

  function harnessRun(agentId: string): RunRecord {
    return {
      id: "run-1",
      identity: { repository, sourceId: "linear", itemId: item.id, triggerId: trigger.id },
      item, trigger, agent: { agentId },
      status: "running", claimedAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z",
    };
  }

  describe("sendPrompt/turn/handoff routing", () => {
    it("routes sendPrompt to the owning harness plugin", async () => {
      const commands: AgentLauncher = { resolve: async () => ({ agentId: "command" }), launch: async () => ({ id: "command-worker", startedAt: "now" }) };
      const sendPrompt = vi.fn(async () => ({ workerId: "worker-1", turnId: "turn-1", status: "running" as const }));
      const harness: HarnessPlugin = { kind: "harness", use: "claude", configSchema: z.object({}), launch: async () => ({ id: "worker-1", startedAt: "now" }), sendPrompt };
      const launcher = new CompositeAgentLauncher(commands, [{ id: "__claude_session", plugin: harness, config: {} }]);
      const worker = { id: "worker-1", startedAt: "now" };
      const run = harnessRun("__claude_session");

      await expect(launcher.sendPrompt(worker, run, { prompt: "continue" })).resolves.toEqual({ workerId: "worker-1", turnId: "turn-1", status: "running" });
      expect(sendPrompt).toHaveBeenCalledWith(worker, { prompt: "continue" });
    });

    it("throws a clear error when the owning harness plugin cannot send a prompt", async () => {
      const commands: AgentLauncher = { resolve: async () => ({ agentId: "command" }), launch: async () => ({ id: "command-worker", startedAt: "now" }) };
      const harness: HarnessPlugin = { kind: "harness", use: "claude", configSchema: z.object({}), launch: async () => ({ id: "worker-1", startedAt: "now" }) };
      const launcher = new CompositeAgentLauncher(commands, [{ id: "__claude_session", plugin: harness, config: {} }]);
      const worker = { id: "worker-1", startedAt: "now" };
      const run = harnessRun("__claude_session");

      await expect(launcher.sendPrompt(worker, run, { prompt: "continue" })).rejects.toThrow(/cannot send a prompt/);
    });

    it("falls back to the command launcher's turn when no harness owns the worker", async () => {
      const turn = vi.fn(async () => ({ workerId: "worker-1", turnId: "turn-1", status: "succeeded" as const, result: "done" }));
      const commands: AgentLauncher = { resolve: async () => ({ agentId: "command" }), launch: async () => ({ id: "command-worker", startedAt: "now" }), turn };
      const launcher = new CompositeAgentLauncher(commands, []);
      const worker = { id: "worker-1", startedAt: "now" };
      const run = harnessRun("command");

      await expect(launcher.turn(worker, run, "turn-1")).resolves.toEqual({ workerId: "worker-1", turnId: "turn-1", status: "succeeded", result: "done" });
      expect(turn).toHaveBeenCalledWith(worker, run, "turn-1");
    });

    it("throws a clear error when neither the harness nor the command launcher can read a turn", async () => {
      const commands: AgentLauncher = { resolve: async () => ({ agentId: "command" }), launch: async () => ({ id: "command-worker", startedAt: "now" }) };
      const launcher = new CompositeAgentLauncher(commands, []);
      const worker = { id: "worker-1", startedAt: "now" };
      const run = harnessRun("command");

      await expect(launcher.turn(worker, run, "turn-1")).rejects.toThrow(/cannot read a worker turn/);
    });

    it("routes handoff to the owning harness plugin", async () => {
      const commands: AgentLauncher = { resolve: async () => ({ agentId: "command" }), launch: async () => ({ id: "command-worker", startedAt: "now" }) };
      const handoffResult = { target: "claude-app", handedOffAt: "2026-09-28T00:00:00.000Z", chainStatus: "succeeded" as const };
      const handoff = vi.fn(async () => handoffResult);
      const harness: HarnessPlugin = { kind: "harness", use: "claude", configSchema: z.object({}), launch: async () => ({ id: "worker-1", startedAt: "now" }), handoff };
      const launcher = new CompositeAgentLauncher(commands, [{ id: "__claude_session", plugin: harness, config: {} }]);
      const worker = { id: "worker-1", startedAt: "now" };
      const run = harnessRun("__claude_session");

      await expect(launcher.handoff(worker, run, { force: true })).resolves.toEqual(handoffResult);
      expect(handoff).toHaveBeenCalledWith(worker, { force: true });
    });

    it("throws a clear error when the owning harness plugin cannot hand off a worker", async () => {
      const commands: AgentLauncher = { resolve: async () => ({ agentId: "command" }), launch: async () => ({ id: "command-worker", startedAt: "now" }) };
      const harness: HarnessPlugin = { kind: "harness", use: "claude", configSchema: z.object({}), launch: async () => ({ id: "worker-1", startedAt: "now" }) };
      const launcher = new CompositeAgentLauncher(commands, [{ id: "__claude_session", plugin: harness, config: {} }]);
      const worker = { id: "worker-1", startedAt: "now" };
      const run = harnessRun("__claude_session");

      await expect(launcher.handoff(worker, run)).rejects.toThrow(/cannot hand off/);
    });
  });
});
