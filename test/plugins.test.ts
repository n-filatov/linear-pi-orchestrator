import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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

describe("managed plugin store", () => {
  async function fixture(options: { name: string; use: string; kind: string; entry?: string; withManifest?: boolean }): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "relay-plugin-fixture-"));
    const entry = options.entry ?? "index.js";
    await mkdir(dirname(join(directory, entry)), { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: options.name, version: "1.2.3", type: "module",
      exports: { ".": { import: `./${entry}` } },
      main: `./${entry}`,
    }));
    await writeFile(join(directory, entry), [
      `export default {`,
      `  kind: ${JSON.stringify(options.kind)},`,
      `  use: ${JSON.stringify(options.use)},`,
      `  configSchema: { parse: (value) => value ?? {} },`,
      `  async execute() { return { status: "succeeded" }; },`,
      `};`,
    ].join("\n"));
    if (options.withManifest !== false) {
      await writeFile(join(directory, "relay-plugin.json"), JSON.stringify({
        name: options.name, version: "1.2.3", kind: options.kind, use: options.use, minRelayVersion: "0.1.0",
      }));
    }
    return directory;
  }

  async function install(source: string, store: string) {
    const { installPlugin } = await import("../src/plugins/store.js");
    const { loadPluginFromEntry } = await import("../src/plugins/loader.js");
    return installPlugin({
      reference: source,
      directory: store,
      validate: async (entry) => {
        const loaded = await loadPluginFromEntry(entry);
        return { kind: loaded.kind, use: loaded.use };
      },
    });
  }

  it("reduces a package reference to its name, and leaves paths and URLs alone", async () => {
    const { referenceName } = await import("../src/plugins/store.js");
    expect(referenceName("@scope/relay-thing")).toBe("@scope/relay-thing");
    expect(referenceName("@scope/relay-thing@1.2.3")).toBe("@scope/relay-thing");
    expect(referenceName("relay-thing@^2")).toBe("relay-thing");
    expect(referenceName("./local")).toBeUndefined();
    expect(referenceName("/abs/path")).toBeUndefined();
    expect(referenceName("git+https://example.invalid/x.git")).toBeUndefined();
  });

  it("prefers an exports entry over main", async () => {
    const { packageEntry } = await import("../src/plugins/store.js");
    expect(packageEntry("/pkg", { exports: { ".": { import: "./dist/index.js" } }, main: "./legacy.js" })).toBe("/pkg/dist/index.js");
    expect(packageEntry("/pkg", { main: "./legacy.js" })).toBe("/pkg/legacy.js");
    expect(packageEntry("/pkg", {})).toBe("/pkg/index.js");
    expect(packageEntry("/pkg", { exports: "./flat.js" })).toBe("/pkg/flat.js");
  });

  it("installs a package, records an absolute entry, and loads it back by name or use", async () => {
    const source = await fixture({ name: "relay-fixture-action", use: "fixture-action", kind: "action", entry: "dist/index.js" });
    const store = await mkdtemp(join(tmpdir(), "relay-plugin-store-"));
    const { loadRelayPlugin } = await import("../src/plugins/loader.js");
    const { checkPlugin, readPluginLock } = await import("../src/plugins/store.js");

    const result = await install(source, store);
    expect(result.plugin).toMatchObject({ name: "relay-fixture-action", version: "1.2.3", kind: "action", use: "fixture-action", minRelayVersion: "0.1.0" });
    expect(isAbsolute(result.plugin.entry)).toBe(true);
    expect(result.plugin.integrity).toMatch(/^sha256-/);

    // Only an absolute path can be imported from the released compiled binary,
    // which has no node_modules of its own.
    const lock = await readPluginLock(store);
    await expect(loadRelayPlugin("relay-fixture-action", "/nowhere", lock)).resolves.toMatchObject({ kind: "action", use: "fixture-action" });
    await expect(loadRelayPlugin("fixture-action", "/nowhere", lock)).resolves.toMatchObject({ use: "fixture-action" });
    expect(await checkPlugin("relay-fixture-action", lock)).toMatchObject({ state: "ok" });
  });

  it("reports a plugin that is missing, altered, or never installed", async () => {
    const source = await fixture({ name: "relay-fixture-health", use: "fixture-health", kind: "action" });
    const store = await mkdtemp(join(tmpdir(), "relay-plugin-health-"));
    const { checkPlugin, readPluginLock } = await import("../src/plugins/store.js");
    const { plugin } = await install(source, store);
    const lock = await readPluginLock(store);

    expect(await checkPlugin("nothing-installed", lock)).toEqual({ state: "not-installed", specifier: "nothing-installed" });

    await appendFile(plugin.entry, "\n// tampered\n");
    expect(await checkPlugin("relay-fixture-health", lock)).toMatchObject({ state: "integrity-mismatch" });

    await rm(plugin.entry);
    expect(await checkPlugin("relay-fixture-health", lock)).toMatchObject({ state: "missing-file" });
  });

  it("refuses a package whose manifest disagrees with what it exports", async () => {
    const source = await fixture({ name: "relay-fixture-liar", use: "declared-use", kind: "action" });
    // The manifest claims one `use`; the module exports another.
    await writeFile(join(source, "relay-plugin.json"), JSON.stringify({ name: "relay-fixture-liar", version: "1.2.3", kind: "source", use: "declared-use" }));
    const store = await mkdtemp(join(tmpdir(), "relay-plugin-liar-"));
    await expect(install(source, store)).rejects.toThrow(/declares kind 'source' .* exports kind 'action'/);
  });

  it("removes a plugin from the lockfile and the directory", async () => {
    const source = await fixture({ name: "relay-fixture-remove", use: "fixture-remove", kind: "action" });
    const store = await mkdtemp(join(tmpdir(), "relay-plugin-remove-"));
    const { readPluginLock, removePlugin } = await import("../src/plugins/store.js");
    await install(source, store);

    const removed = await removePlugin("relay-fixture-remove", store);
    expect(removed.name).toBe("relay-fixture-remove");
    expect((await readPluginLock(store)).plugins).toEqual({});
    await expect(removePlugin("relay-fixture-remove", store)).rejects.toThrow(/is not installed/);
  });

  it("names the install command when a plugin cannot be resolved at all", async () => {
    const { loadRelayPlugin } = await import("../src/plugins/loader.js");
    await expect(loadRelayPlugin("@nobody/relay-absent", "/nowhere", { version: 1, plugins: {} }))
      .rejects.toThrow(/relay plugin install @nobody\/relay-absent/);
  });

  it("still loads a local module path without consulting the store", async () => {
    const project = await mkdtemp(join(tmpdir(), "relay-plugin-local-"));
    await writeFile(join(project, "local.mjs"), `export default { kind: "action", use: "local-action", configSchema: { parse: (v) => v ?? {} } };`);
    const { loadRelayPlugin } = await import("../src/plugins/loader.js");
    await expect(loadRelayPlugin("./local.mjs", project, { version: 1, plugins: {} })).resolves.toMatchObject({ use: "local-action" });
  });
});
