import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRules = {
  domain: [],
  "plugin-sdk": ["domain"],
  "plugin-host": ["plugin-sdk"],
  config: [],
  "plugin-testing": ["plugin-host", "plugin-sdk"],
  application: ["domain", "plugin-sdk"],
  "storage-sqlite": ["domain"],
  "global-registry": ["domain"],
  "trigger-command": ["domain"],
  "trigger-linear-issue-change": ["domain", "integration-linear"],
  "integration-linear": [],
  "action-launch": ["plugin-sdk"],
  "action-cleanup": ["domain", "plugin-sdk"],
  "action-command": ["plugin-sdk"],
  "action-worker-exec": ["plugin-sdk"],
  "action-worker-send": ["plugin-sdk"],
  "action-tmux-create-window": ["plugin-sdk"],
  "action-codex-start-session": ["plugin-sdk"],
  "action-codex-send-prompt": ["plugin-sdk"],
};
const violations = [];

async function visit(directory, packageName) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file, packageName);
    else if (entry.name.endsWith(".ts")) {
      const text = await readFile(file, "utf8");
      const packageRoot = path.join(root, "packages", packageName);
      for (const match of text.matchAll(/(?:from\s+|import\s*\()["'](\.[^"']+)["']/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (!target.startsWith(`${packageRoot}${path.sep}`)) {
          violations.push(`${path.relative(root, file)} escapes its package through '${match[1]}'`);
        }
      }
      if (/(?:from\s+|import\s*\()["'](?:\.\.?\/)*(?:src|packages)\//.test(text) || /from\s+["'](?:\.\.\/){2,}src\//.test(text)) {
        violations.push(`${path.relative(root, file)} imports an implementation path outside its package`);
      }
      const permitted = packageRules[packageName] ?? [];
      for (const match of text.matchAll(/(?:from\s+|import\s*\()["']@task-relay\/([^"']+)["']/g)) {
        if (!permitted.includes(match[1])) violations.push(`${path.relative(root, file)} may not import @task-relay/${match[1]}`);
      }
    }
  }
}

for (const name of Object.keys(packageRules)) await visit(path.join(root, "packages", name, "src"), name);
if (violations.length) throw new Error(`Import boundary violations:\n${violations.join("\n")}`);
console.log("Package import boundaries ok");
