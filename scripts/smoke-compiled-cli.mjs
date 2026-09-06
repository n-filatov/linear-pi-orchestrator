/**
 * Release-gate smoke test for a compiled Relay executable.
 *
 * It creates an isolated project, loads a local action plugin by path, polls a
 * no-shell command source once, then reads the persisted workflow result with
 * a fresh CLI process. Nothing is registered with the dashboard or written to
 * a user repository.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const binary = process.argv[2];
if (!binary) throw new Error("Usage: node scripts/smoke-compiled-cli.mjs <compiled-relay-binary>");
const executable = resolve(binary);
const project = await mkdtemp(join(tmpdir(), "relay-compiled-smoke-"));
const marker = join(project, "plugin-ran.json");
const environment = { ...process.env, XDG_STATE_HOME: join(project, "state") };
const sourceProgram = "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'SMOKE-1',title:'Compiled CLI'}]}))";

try {
  await writeFile(join(project, "plugin.mjs"), [
    "import { writeFileSync } from 'node:fs';",
    "export default { kind: 'action', use: 'compiled-smoke', configSchema: { parse: value => value ?? {} },",
    "async execute(context) {",
    `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ item: context.item.id, invocation: context.executionId }));`,
    "return { status: 'succeeded', output: { verified: true } }; } };",
  ].join("\n"));
  await writeFile(join(project, ".task-relay.yaml"), [
    "version: 2", "project: { name: compiled-smoke }",
    "sources:", "  queue:", "    use: command", "    with:", `      discover: { command: ${JSON.stringify(process.execPath)}, args: ["-e", ${JSON.stringify(sourceProgram)}] }`,
    "workflows:", "  compiled:", "    on: { source: queue }", "    jobs:", "      plugin: { use: ./plugin.mjs, with: {} }",
    "logging: { level: silent, pretty: false }",
  ].join("\n"));

  await run(executable, ["once"], { cwd: project, timeout: 30_000, env: environment });
  const markerValue = JSON.parse(await readFile(marker, "utf8"));
  if (markerValue.item !== "SMOKE-1") throw new Error("The local plugin did not receive the discovered item.");
  const { stdout } = await run(executable, ["workflow", "runs", "--json"], { cwd: project, timeout: 30_000, env: environment });
  const runs = JSON.parse(stdout);
  if (!Array.isArray(runs) || !runs.some((entry) => entry.identity?.workflowId === "compiled" && entry.jobs?.plugin?.outputs?.verified === true)) {
    throw new Error("The workflow output was not persisted and readable after the compiled CLI restarted.");
  }
  console.log(JSON.stringify({ project: "disposable", dynamicPlugin: true, persistedWorkflow: true }));
} finally {
  await rm(project, { recursive: true, force: true });
}
