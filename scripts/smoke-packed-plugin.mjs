import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await mkdtemp(path.join(tmpdir(), "relay-packed-plugin-"));
const cache = path.join(workspace, "npm-cache");

try {
  const { stdout } = await run("npm", ["--cache", cache, "pack", "--ignore-scripts", "--json", "--pack-destination", workspace], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  const report = stdout.slice(Math.max(0, stdout.lastIndexOf("\n[\n")));
  const [{ filename }] = JSON.parse(report);
  if (!filename) throw new Error("npm pack did not report a tarball.");

  const extracted = path.join(workspace, "extracted");
  await mkdir(extracted);
  await run("tar", ["-xzf", path.join(workspace, filename), "-C", extracted], { maxBuffer: 10 * 1024 * 1024 });
  const entry = path.join(extracted, "package", "dist", "plugin.js");
  const { stdout: imported } = await run(process.execPath, ["-e", `import(${JSON.stringify(entry)}).then((plugin) => { const registry = new plugin.RelayPluginRegistry(); console.log(JSON.stringify({ api: plugin.PLUGIN_SDK_API_VERSION, validate: typeof plugin.validatePluginContract, registry: registry.constructor.name })); })`]);
  const result = JSON.parse(imported);
  if (result.api !== 1 || result.validate !== "function" || result.registry !== "RelayPluginRegistry") throw new Error("Packed task-relay/plugin is missing its public compatibility API.");
  console.log(JSON.stringify({ packedPlugin: true, isolatedDependencies: true }));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
