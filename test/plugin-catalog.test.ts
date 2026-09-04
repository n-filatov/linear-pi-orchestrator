import { describe, expect, it } from "vitest";
import { normalizeRelayConfig } from "../src/config/v2.js";
import { buildPluginCatalog } from "../src/plugins/catalog.js";

describe("plugin catalog", () => {
  it("exposes only JSON-safe metadata and schemas for shipped node types", async () => {
    const config = normalizeRelayConfig({
      version: 2,
      sources: { queue: { use: "command", with: { discover: { command: "/bin/echo" } } } },
      harnesses: { main: { use: "codex" } },
    });
    const catalog = await buildPluginCatalog({ config, projectRoot: process.cwd(), includeInstalled: false });
    const tmuxWindow = catalog.entries.find((entry) => entry.id === "action:tmux.create-window");
    const commandSource = catalog.entries.find((entry) => entry.id === "source:command");
    const codex = catalog.entries.find((entry) => entry.id === "harness:codex");
    expect(tmuxWindow).toMatchObject({ health: "built-in", presentation: { name: "Start tmux window", category: "Automation" } });
    expect(tmuxWindow?.configSchema).toBeTypeOf("object");
    expect(commandSource).toMatchObject({ kind: "source", health: "built-in" });
    expect(commandSource?.matchSchema).toBeTypeOf("object");
    expect(codex).toMatchObject({ kind: "harness", health: "built-in" });
    expect(JSON.stringify(catalog)).not.toContain("execute");
  });
});
