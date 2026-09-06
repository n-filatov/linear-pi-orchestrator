import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { parse, stringify } from "yaml";
import { ZodError } from "zod";
import { mergeConfigDocuments } from "@task-relay/config";
import { normalizeRelayConfig, type RelayConfigV2 } from "./schema.js";

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


async function yamlFile(path: string): Promise<unknown | undefined> {
  const explorer = cosmiconfig("task-relay", { searchPlaces: [CONFIG_FILE], loaders: { ".yaml": (_path, content) => parse(content), ".yml": (_path, content) => parse(content) } });
  const loaded = await explorer.load(path);
  return loaded?.config;
}

/**
 * Always returns the normalized v2 shape. Existing version: 1 files remain
 * valid and are converted in memory; `relay config migrate` can later write
 * the equivalent v2 document explicitly.
 */
export async function loadRelayConfig(start?: string): Promise<{ config: RelayConfigV2; projectRoot: string; configPath: string; localConfigPath?: string }> {
  const projectRoot = await findProjectRoot(start);
  const configPath = resolve(projectRoot, CONFIG_FILE);
  if (!existsSync(configPath)) throw new RelayConfigError(`No ${CONFIG_FILE} found for ${projectRoot}. Run 'relay init' first.`);
  const localPath = resolve(projectRoot, LOCAL_CONFIG_FILE);
  try {
    const merged = mergeConfigDocuments(await yamlFile(configPath), existsSync(localPath) ? await yamlFile(localPath) : undefined);
    const config = normalizeRelayConfig(merged);
    return { config, projectRoot, configPath, localConfigPath: existsSync(localPath) ? localPath : undefined };
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`);
      throw new RelayConfigError(`Invalid ${basename(configPath)}:\n${issues.map((line) => `  - ${line}`).join("\n")}`, issues);
    }
    throw new RelayConfigError(`Could not load ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function renderRelayConfig(config: RelayConfigV2): string { return stringify(config, { lineWidth: 0 }); }
