import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import writeFileAtomic from "write-file-atomic";

/**
 * A user-level directory holding installed plugin packages.
 *
 * The layout is deliberately an ordinary npm project: npm resolves the package
 * and its production dependencies into `node_modules`, and a plugin loaded by
 * absolute path resolves its own bare imports by walking up to that same
 * `node_modules`. This is what makes plugins work inside the released
 * `bun build --compile` executable, which has no `node_modules` of its own and
 * therefore cannot resolve a bare specifier at all — only an absolute path.
 */
export function pluginDirectory(): string {
  const base = process.env.RELAY_PLUGIN_HOME || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "task-relay", "plugins");
  return resolve(base);
}

export function pluginLockPath(directory = pluginDirectory()): string {
  return join(directory, "plugins.json");
}

export interface InstalledPlugin {
  /** Package name, which is also how configuration usually names it. */
  name: string;
  version: string;
  kind: "source" | "action" | "harness";
  /** The plugin's own `use` id, accepted as an alias for the package name. */
  use: string;
  /** What the user asked to install, retained for reinstalls. */
  reference: string;
  /** Absolute path handed to `import()`. Never a bare specifier. */
  entry: string;
  integrity: string;
  minRelayVersion?: string;
  installedAt: string;
}

export interface PluginLock {
  version: 1;
  plugins: Record<string, InstalledPlugin>;
}

export async function readPluginLock(directory = pluginDirectory()): Promise<PluginLock> {
  try {
    const parsed = JSON.parse(await readFile(pluginLockPath(directory), "utf8")) as Partial<PluginLock>;
    return { version: 1, plugins: parsed.plugins ?? {} };
  } catch { return { version: 1, plugins: {} }; }
}

async function writePluginLock(lock: PluginLock, directory = pluginDirectory()): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFileAtomic(pluginLockPath(directory), `${JSON.stringify(lock, null, 2)}\n`);
}

/** Finds an installed plugin by package name or by its declared `use` id. */
export function findInstalledPlugin(lock: PluginLock, specifier: string): InstalledPlugin | undefined {
  return lock.plugins[specifier] ?? Object.values(lock.plugins).find((plugin) => plugin.use === specifier);
}

export async function fileIntegrity(path: string): Promise<string> {
  return `sha256-${createHash("sha256").update(await readFile(path)).digest("base64")}`;
}

/** npm needs a project of its own here, or it walks up and installs elsewhere. */
async function ensureManagedProject(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const manifest = join(directory, "package.json");
  if (existsSync(manifest)) return;
  await writeFileAtomic(manifest, `${JSON.stringify({
    name: "task-relay-plugins",
    version: "1.0.0",
    private: true,
    description: "Managed by Task Relay. Install plugins with 'relay plugin install'.",
  }, null, 2)}\n`);
}

export interface PackageManifest {
  name?: string;
  version?: string;
  main?: string;
  exports?: unknown;
}

/**
 * The file `import()` should be given. `exports["."]` wins over `main` because a
 * package with an exports map has declared it as the supported entry.
 */
export function packageEntry(packageDirectory: string, manifest: PackageManifest): string {
  const fromExports = exportsEntry(manifest.exports);
  const relative = fromExports ?? manifest.main ?? "index.js";
  return resolve(packageDirectory, relative);
}

function exportsEntry(exported: unknown): string | undefined {
  if (typeof exported === "string") return exported;
  if (exported === null || typeof exported !== "object" || Array.isArray(exported)) return undefined;
  const record = exported as Record<string, unknown>;
  const root = "." in record ? record["."] : record;
  if (typeof root === "string") return root;
  if (root === null || typeof root !== "object") return undefined;
  for (const key of ["import", "module", "default", "require"]) {
    const candidate = (root as Record<string, unknown>)[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

export interface InstallResult {
  plugin: InstalledPlugin;
  /** Present when this replaced an earlier version. */
  replaced?: string;
}

/**
 * Installs a package into the managed directory and records where it landed.
 *
 * The package is imported and checked before the lockfile is written: an entry
 * in the lockfile is a promise that the path loads and exports a valid plugin.
 */
export async function installPlugin(input: {
  reference: string;
  directory?: string;
  /** Validates the imported module. Supplied by the caller to avoid a cycle. */
  validate: (entry: string) => Promise<{ kind: "source" | "action" | "harness"; use: string }>;
  now?: () => Date;
}): Promise<InstallResult> {
  const directory = input.directory ?? pluginDirectory();
  await ensureManagedProject(directory);

  const installed = await execa("npm", [
    "install", "--prefix", directory, "--omit=dev", "--no-audit", "--no-fund", "--save-exact", input.reference,
  ], { reject: false });
  if (installed.exitCode !== 0) {
    throw new Error(`Could not install '${input.reference}': ${installed.stderr.trim() || `npm exited with code ${installed.exitCode}`}`);
  }

  const name = await installedPackageName(directory, input.reference);
  const packageDirectory = join(directory, "node_modules", name);
  const manifestPath = join(packageDirectory, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`npm reported success, but ${name} is not present in ${directory}.`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
  const entry = packageEntry(packageDirectory, manifest);
  if (!existsSync(entry)) {
    throw new Error(`Plugin ${name} declares an entry point that is not published: ${entry}. Its 'files' field probably omits the build output.`);
  }

  const contract = await input.validate(entry);
  const declared = await pluginManifest(packageDirectory);
  if (declared?.kind && declared.kind !== contract.kind) {
    throw new Error(`${name} declares kind '${declared.kind}' in relay-plugin.json but exports kind '${contract.kind}'.`);
  }
  if (declared?.use && declared.use !== contract.use) {
    throw new Error(`${name} declares use '${declared.use}' in relay-plugin.json but exports use '${contract.use}'.`);
  }

  const lock = await readPluginLock(directory);
  const replaced = lock.plugins[name]?.version;
  lock.plugins[name] = {
    name,
    version: manifest.version ?? "0.0.0",
    kind: contract.kind,
    use: contract.use,
    reference: input.reference,
    entry,
    integrity: await fileIntegrity(entry),
    ...(declared?.minRelayVersion ? { minRelayVersion: declared.minRelayVersion } : {}),
    installedAt: (input.now?.() ?? new Date()).toISOString(),
  };
  await writePluginLock(lock, directory);
  return { plugin: lock.plugins[name], ...(replaced && replaced !== lock.plugins[name].version ? { replaced } : {}) };
}

export async function removePlugin(name: string, directory = pluginDirectory()): Promise<InstalledPlugin> {
  const lock = await readPluginLock(directory);
  const plugin = lock.plugins[name];
  if (!plugin) throw new Error(`Plugin '${name}' is not installed.`);
  const removed = await execa("npm", ["uninstall", "--prefix", directory, "--no-audit", "--no-fund", name], { reject: false });
  if (removed.exitCode !== 0 && existsSync(join(directory, "node_modules", name))) {
    throw new Error(`Could not remove '${name}': ${removed.stderr.trim() || `npm exited with code ${removed.exitCode}`}`);
  }
  delete lock.plugins[name];
  await writePluginLock(lock, directory);
  return plugin;
}

export type PluginHealth =
  | { state: "ok"; plugin: InstalledPlugin }
  | { state: "missing-file"; plugin: InstalledPlugin }
  | { state: "integrity-mismatch"; plugin: InstalledPlugin; found: string }
  | { state: "not-installed"; specifier: string };

/** What `relay doctor` reports for one configured plugin reference. */
export async function checkPlugin(specifier: string, lock: PluginLock): Promise<PluginHealth> {
  const plugin = findInstalledPlugin(lock, specifier);
  if (!plugin) return { state: "not-installed", specifier };
  if (!existsSync(plugin.entry)) return { state: "missing-file", plugin };
  const found = await fileIntegrity(plugin.entry);
  if (found !== plugin.integrity) return { state: "integrity-mismatch", plugin, found };
  return { state: "ok", plugin };
}

/** Produces a checksummed tarball for local testing or release. */
export async function packPlugin(path: string, destination: string): Promise<{ tarball: string; integrity: string }> {
  await mkdir(destination, { recursive: true });
  const packed = await execa("npm", ["pack", "--pack-destination", destination, "--json"], { cwd: resolve(path), reject: false });
  if (packed.exitCode !== 0) {
    throw new Error(`Could not pack ${path}: ${packed.stderr.trim() || `npm exited with code ${packed.exitCode}`}`);
  }
  const reported = JSON.parse(packed.stdout) as { filename?: string }[];
  const filename = reported[0]?.filename;
  if (!filename) throw new Error(`npm pack did not report a tarball for ${path}.`);
  const tarball = join(destination, filename);
  return { tarball, integrity: await fileIntegrity(tarball) };
}

/**
 * npm accepts references its installed directory name does not match — a
 * version range, a tarball, a git URL. The package.json npm just wrote is the
 * authority on what was actually installed.
 */
async function installedPackageName(directory: string, reference: string): Promise<string> {
  const fromReference = referenceName(reference);
  if (fromReference && existsSync(join(directory, "node_modules", fromReference, "package.json"))) return fromReference;
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const names = Object.keys(manifest.dependencies ?? {});
  if (names.length === 0) throw new Error(`npm installed '${reference}' but recorded no dependency in ${directory}.`);
  // The most recently added dependency is the one just installed.
  const candidate = fromReference && names.includes(fromReference) ? fromReference : names[names.length - 1];
  return candidate;
}

/** `@scope/name@1.2.3` and `name@^1` reduce to their package name; a URL does not. */
export function referenceName(reference: string): string | undefined {
  if (/^[./]/.test(reference) || /^[a-z+]+:/i.test(reference)) return undefined;
  const scoped = /^(@[^/]+\/[^@]+)(?:@.+)?$/.exec(reference);
  if (scoped) return scoped[1];
  const plain = /^([^@][^@]*)(?:@.+)?$/.exec(reference);
  return plain?.[1];
}

/** Optional discovery metadata shipped beside a plugin. */
async function pluginManifest(packageDirectory: string): Promise<{ kind?: string; use?: string; minRelayVersion?: string } | undefined> {
  const path = join(packageDirectory, "relay-plugin.json");
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(await readFile(path, "utf8")) as { kind?: string; use?: string; minRelayVersion?: string }; }
  catch { return undefined; }
}

export async function purgePluginDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
