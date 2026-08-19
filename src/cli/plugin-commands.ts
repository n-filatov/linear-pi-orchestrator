import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { isPlugin } from "../plugins/loader.js";
import { BUILT_IN_ACTIONS, BUILT_IN_HARNESSES, BUILT_IN_SOURCES } from "../plugins/built-ins.js";

export interface RelayPluginManifest {
  name: string;
  version: string;
  kind: "source" | "action" | "harness";
  use: string;
  minRelayVersion?: string;
  description?: string;
  configSchema?: Record<string, unknown>;
  capabilities?: string[];
}

function validateManifest(raw: unknown): RelayPluginManifest {
  if (!raw || typeof raw !== "object") throw new Error("relay-plugin.json must be a JSON object.");
  const m = raw as Record<string, unknown>;
  const required = ["name", "version", "kind", "use"] as const;
  for (const key of required) {
    if (typeof m[key] !== "string") throw new Error(`relay-plugin.json: field '${key}' must be a non-empty string.`);
  }
  if (!["source", "action", "harness"].includes(m.kind as string)) {
    throw new Error(`relay-plugin.json: 'kind' must be 'source', 'action', or 'harness', got '${m.kind}'.`);
  }
  return m as unknown as RelayPluginManifest;
}

function pluginPackageJson(name: string, kind: string): string {
  return JSON.stringify({
    name,
    version: "0.1.0",
    description: `Task Relay ${kind} plugin`,
    type: "module",
    exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    main: "./dist/index.js",
    files: ["dist", "relay-plugin.json", "README.md"],
    scripts: {
      build: "tsc",
      check: "tsc --noEmit",
      test: "vitest run",
      prepublishOnly: "npm run build && npm test",
    },
    peerDependencies: { "task-relay": ">=0.1.0", zod: ">=3.0.0" },
    devDependencies: {
      "@types/node": "^22.0.0",
      typescript: "^5.0.0",
      vitest: "^3.0.0",
      "task-relay": "file:.",
      zod: "^3.0.0",
    },
    keywords: ["task-relay", "relay-plugin", kind],
    license: "MIT",
  }, null, 2);
}

function pluginTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      declaration: true,
      outDir: "dist",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.test.ts"],
  }, null, 2);
}

function pluginManifest(name: string, use: string, kind: "source" | "action" | "harness"): string {
  const manifest: RelayPluginManifest = {
    name,
    version: "0.1.0",
    kind,
    use,
    minRelayVersion: "0.1.0",
    description: `Task Relay ${kind} plugin`,
    capabilities: [],
  };
  return JSON.stringify(manifest, null, 2);
}

function sourcePluginTemplate(use: string): string {
  return `import { z } from "zod";
import type { SourcePlugin, SourcePluginContext, WorkItem } from "task-relay/plugin";

const configSchema = z.object({
  // Add your source configuration fields here
  example: z.string().optional(),
});

const matchSchema = z.object({
  // Add your match/filter fields here
  labels: z.array(z.string()).optional(),
});

type Config = z.infer<typeof configSchema>;
type Match = z.infer<typeof matchSchema>;

const plugin: SourcePlugin<Config, Match> = {
  kind: "source",
  use: "${use}",
  configSchema,
  matchSchema,

  async discover(context: SourcePluginContext<Config, Match>): Promise<readonly WorkItem[]> {
    // TODO: implement discovery — fetch work items from your source
    // context.config holds your validated configuration
    // context.match holds the trigger's match criteria
    return [];
  },

  // Optional: filter items after discovery
  // async matches(item, match, context) { return true; },

  // Optional: report lifecycle events back to the source
  // async report(event, config) { },

  // Optional: clean up connections when the relay stops
  // async close() { },
};

export default plugin;
`;
}

function actionPluginTemplate(use: string): string {
  return `import { z } from "zod";
import type { ActionPlugin, ActionContext, ActionResult } from "task-relay/plugin";

const configSchema = z.object({
  // Add your action configuration fields here
  example: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

const plugin: ActionPlugin<Config> = {
  kind: "action",
  use: "${use}",
  configSchema,
  // target: "item",  // or "worker" for per-worker actions

  async execute(context: ActionContext, config: Config): Promise<ActionResult> {
    // TODO: implement the action
    // context.item is the work item that triggered this
    // context.worker is set when target is "worker"
    return { status: "succeeded", message: "Action completed." };
  },
};

export default plugin;
`;
}

function harnessPluginTemplate(use: string): string {
  return `import { z } from "zod";
import type { HarnessPlugin, HarnessLaunchRequest, WorkerHandle } from "task-relay/plugin";

const configSchema = z.object({
  // Add your harness configuration fields here
  command: z.string().default("my-agent"),
  args: z.array(z.string()).default([]),
});

type Config = z.infer<typeof configSchema>;

const plugin: HarnessPlugin<Config> = {
  kind: "harness",
  use: "${use}",
  configSchema,

  async launch(request: HarnessLaunchRequest<Config>): Promise<WorkerHandle> {
    // TODO: launch your agent process
    // request.workerId is the unique worker identifier
    // request.prompt is the rendered prompt text
    // request.workspace.path is the isolated checkout directory
    throw new Error("Not implemented");
  },

  // Optional: wait for an in-process worker to finish
  // async wait(worker) { return undefined; },

  // Optional: reconcile a worker after relay restart
  // async reconcile(worker) { return undefined; },

  // Optional: stop a worker
  // async stop(worker) { },
};

export default plugin;
`;
}

function pluginTestTemplate(use: string, kind: string): string {
  return `import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("${use} ${kind} plugin", () => {
  it("has correct kind and use", () => {
    expect(plugin.kind).toBe("${kind}");
    expect(plugin.use).toBe("${use}");
  });

  it("has valid configSchema", () => {
    expect(plugin.configSchema).toBeDefined();
    // Valid config with defaults should parse without error
    expect(() => plugin.configSchema.parse({})).not.toThrow();
  });

  ${kind === "source" ? `
  it("has valid matchSchema", () => {
    expect(plugin.matchSchema).toBeDefined();
    expect(() => plugin.matchSchema.parse({})).not.toThrow();
  });

  it("returns an array from discover", async () => {
    const result = await plugin.discover({
      sourceId: "test",
      config: plugin.configSchema.parse({}),
      match: plugin.matchSchema.parse({}),
      repository: { id: "test-repo", root: "/tmp/test" },
    });
    expect(Array.isArray(result)).toBe(true);
  });
  ` : ""}
  ${kind === "action" ? `
  it("returns ActionResult from execute", async () => {
    const result = await plugin.execute(
      {
        executionId: "test",
        actionId: "test",
        triggerId: "test",
        repository: { id: "test-repo", root: "/tmp/test" },
        sourceId: "test",
        item: { sourceId: "test", id: "ITEM-1", title: "Test item" },
        outputs: {},
        workers: {
          async launch() { return { status: "succeeded" }; },
          async cleanup() { return { status: "succeeded" }; },
        },
      } as never,
      plugin.configSchema.parse({}),
    );
    expect(["succeeded", "skipped"]).toContain(result.status);
  });
  ` : ""}
});
`;
}

function pluginReadme(name: string, use: string, kind: string): string {
  return `# ${name}

A Task Relay **${kind}** plugin that adds the \`${use}\` extension.

## Installation

\`\`\`bash
relay plugin install ${name}
\`\`\`

## Configuration

Add to your \`.task-relay.yaml\`:

\`\`\`yaml
${kind === "source" ? `sources:
  my-source:
    use: ${name}
    with:
      # Your source configuration here` : ""}${kind === "action" ? `actions:
  my-action:
    use: ${name}
    with:
      # Your action configuration here` : ""}${kind === "harness" ? `harnesses:
  my-harness:
    use: ${name}
    with:
      # Your harness configuration here` : ""}
\`\`\`

## Capabilities

<!-- List any external services, environment variables, or credentials this plugin requires -->

## Development

\`\`\`bash
npm install
npm run check   # typecheck
npm test        # run tests
relay plugin validate .  # validate plugin contract
\`\`\`

## License

MIT
`;
}

export function addPluginCommands(program: Command, print: (value: string) => void): void {
  const plugin = program.command("plugin").description("Manage Task Relay plugins.");

  plugin.command("init <name>")
    .description("Scaffold a new plugin repository directory.")
    .option("--kind <kind>", "plugin kind: source, action, or harness", "action")
    .option("--use <use>", "plugin use identifier (defaults to the name)")
    .option("--dir <dir>", "output directory (defaults to <name>)")
    .action(async (name: string, flags: { kind?: string; use?: string; dir?: string }) => {
      const kind = (flags.kind || "action") as "source" | "action" | "harness";
      if (!["source", "action", "harness"].includes(kind)) {
        throw new Error(`--kind must be 'source', 'action', or 'harness', got '${kind}'.`);
      }
      const use = flags.use || name.replace(/^@[^/]+\//, "").replace(/^relay-plugin-/, "");
      const outDir = path.resolve(flags.dir || name);

      if (existsSync(outDir)) throw new Error(`Directory already exists: ${outDir}`);

      await mkdir(path.join(outDir, "src"), { recursive: true });

      const sourceCode =
        kind === "source" ? sourcePluginTemplate(use) :
        kind === "action" ? actionPluginTemplate(use) :
        harnessPluginTemplate(use);

      await Promise.all([
        writeFile(path.join(outDir, "package.json"), pluginPackageJson(name, kind)),
        writeFile(path.join(outDir, "tsconfig.json"), pluginTsConfig()),
        writeFile(path.join(outDir, "relay-plugin.json"), pluginManifest(name, use, kind)),
        writeFile(path.join(outDir, "README.md"), pluginReadme(name, use, kind)),
        writeFile(path.join(outDir, "src", "index.ts"), sourceCode),
        writeFile(path.join(outDir, "src", "index.test.ts"), pluginTestTemplate(use, kind)),
      ]);

      print(`Created plugin scaffold: ${outDir}`);
      print(`  kind: ${kind}  use: ${use}`);
      print(`\nNext steps:`);
      print(`  cd ${name}`);
      print(`  npm install`);
      print(`  # implement src/index.ts`);
      print(`  npm run check && npm test`);
      print(`  relay plugin validate .`);
    });

  plugin.command("validate [path]")
    .description("Validate a plugin directory's manifest and exported contract.")
    .action(async (pluginPath?: string) => {
      const dir = path.resolve(pluginPath || ".");
      const manifestPath = path.join(dir, "relay-plugin.json");

      if (!existsSync(manifestPath)) throw new Error(`relay-plugin.json not found in ${dir}`);

      const rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      const manifest = validateManifest(rawManifest);
      print(`Manifest: valid`);
      print(`  name: ${manifest.name}  version: ${manifest.version}`);
      print(`  kind: ${manifest.kind}  use: ${manifest.use}`);

      // Try to load the compiled or source plugin
      const candidates = [
        path.join(dir, "dist", "index.js"),
        path.join(dir, "src", "index.js"),
      ];
      const entry = candidates.find(existsSync);
      if (!entry) {
        print(`\nPlugin entry not found (run \`npm run build\` first). Manifest is valid.`);
        return;
      }

      const imported = await import(pathToFileURL(entry).href) as { default?: unknown; plugin?: unknown };
      const candidate = imported.default ?? imported.plugin;
      if (!isPlugin(candidate)) throw new Error(`Plugin export does not satisfy the RelayPlugin contract.`);

      if (candidate.kind !== manifest.kind) {
        throw new Error(`Manifest says kind='${manifest.kind}' but plugin exports kind='${candidate.kind}'.`);
      }
      if (candidate.use !== manifest.use) {
        throw new Error(`Manifest says use='${manifest.use}' but plugin exports use='${candidate.use}'.`);
      }

      print(`Runtime contract: valid`);
      print(`\nPlugin ${manifest.name}@${manifest.version} is ready.`);
    });

  plugin.command("list")
    .description("List plugins referenced in the current project's configuration.")
    .action(async () => {
      const { loadRelayConfig, findProjectRoot } = await import("../config/load.js");
      const root = await findProjectRoot(process.cwd());
      const { config } = await loadRelayConfig(root);

      const referenced = new Map<string, { use: string; kind: string; locations: string[] }>();
      const record = (use: string, kind: string, location: string) => {
        const entry = referenced.get(use) || { use, kind, locations: [] };
        entry.locations.push(location);
        referenced.set(use, entry);
      };

      for (const [id, source] of Object.entries(config.sources)) {
        if (!BUILT_IN_SOURCES.has(source.use)) record(source.use, "source", `sources.${id}`);
      }
      for (const [id, action] of Object.entries(config.actions)) {
        if (!BUILT_IN_ACTIONS.has(action.use)) record(action.use, "action", `actions.${id}`);
      }
      for (const [id, harness] of Object.entries(config.harnesses)) {
        if (!BUILT_IN_HARNESSES.has(harness.use)) record(harness.use, "harness", `harnesses.${id}`);
      }
      for (const trigger of config.triggers) {
        for (const [index, action] of trigger.actions.entries()) {
          if (typeof action === "string" || BUILT_IN_ACTIONS.has(action.use)) continue;
          record(action.use, "action", `triggers.${trigger.id}.actions.${index}`);
        }
      }

      if (referenced.size === 0) {
        print("No external plugins referenced in this project's configuration.");
        return;
      }

      for (const [use, info] of referenced) {
        print(`${use}  (${info.kind})  — used by: ${info.locations.join(", ")}`);
      }
    });
}
