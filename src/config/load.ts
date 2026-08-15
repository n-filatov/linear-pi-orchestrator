import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { parse, stringify } from "yaml";
import { ZodError } from "zod";
import { relayConfigSchema, type RelayConfig } from "./schema.js";

export const CONFIG_FILE = ".task-relay.yaml";
export const LOCAL_CONFIG_FILE = ".task-relay.local.yaml";

export class RelayConfigError extends Error {
  constructor(message: string, readonly issues: string[] = []) { super(message); this.name = "RelayConfigError"; }
}

export async function findProjectRoot(start = process.cwd()): Promise<string> {
  let current = await realpath(resolve(start));
  while (true) {
    if (existsSync(resolve(current, ".git")) || existsSync(resolve(current, CONFIG_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) return await realpath(resolve(start));
    current = parent;
  }
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override === undefined ? base : override;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = key in result ? deepMerge(result[key], value) : value;
  return result;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

async function yamlFile(path: string): Promise<unknown | undefined> {
  const explorer = cosmiconfig("task-relay", { searchPlaces: [CONFIG_FILE], loaders: { ".yaml": (_path, content) => parse(content), ".yml": (_path, content) => parse(content) } });
  const loaded = await explorer.load(path);
  return loaded?.config;
}

export async function loadRelayConfig(start?: string): Promise<{ config: RelayConfig; projectRoot: string; configPath: string; localConfigPath?: string }> {
  const projectRoot = await findProjectRoot(start);
  const configPath = resolve(projectRoot, CONFIG_FILE);
  if (!existsSync(configPath)) throw new RelayConfigError(`No ${CONFIG_FILE} found for ${projectRoot}. Run 'relay init' first.`);
  const localPath = resolve(projectRoot, LOCAL_CONFIG_FILE);
  try {
    const merged = deepMerge(await yamlFile(configPath), existsSync(localPath) ? await yamlFile(localPath) : undefined);
    const config = relayConfigSchema.parse(merged);
    return { config, projectRoot, configPath, localConfigPath: existsSync(localPath) ? localPath : undefined };
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`);
      throw new RelayConfigError(`Invalid ${basename(configPath)}:\n${issues.map((line) => `  - ${line}`).join("\n")}`, issues);
    }
    throw new RelayConfigError(`Could not load ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function renderRelayConfig(config: RelayConfig): string { return stringify(config, { lineWidth: 0 }); }
