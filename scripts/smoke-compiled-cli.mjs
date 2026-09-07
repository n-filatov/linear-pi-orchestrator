/**
 * Release-gate smoke test for a compiled Relay executable.
 *
 * It creates an isolated project, loads a local action plugin by path, polls a
 * no-shell command source once, then reads the persisted workflow result with
 * a fresh CLI process. It also starts the dashboard and reads both global
 * registries. All state and project registration stay inside the temporary folder.
 */
import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const binary = process.argv[2];
if (!binary) throw new Error("Usage: node scripts/smoke-compiled-cli.mjs <compiled-relay-binary>");
const originalExecutable = resolve(binary);
const project = await realpath(await mkdtemp(join(tmpdir(), "relay-compiled-smoke-")));
const executable = join(project, "relay");
const marker = join(project, "plugin-ran.json");
const environment = { ...process.env, XDG_STATE_HOME: join(project, "state") };
const sourceProgram = "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'SMOKE-1',title:'Compiled CLI'}]}))";

async function checkDashboard() {
  const child = spawn(executable, ["dashboard", "--port", "0", "--no-open"], {
    cwd: project, env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolveClose) => child.once("close", resolveClose));
  let output = "";
  try {
    const address = await new Promise((resolveAddress, reject) => {
      const timer = setTimeout(() => reject(new Error(`Dashboard startup timed out: ${output}`)), 15_000);
      const finish = (error, url) => {
        clearTimeout(timer);
        if (error) reject(error); else resolveAddress(url);
      };
      child.once("error", (error) => finish(error));
      child.once("exit", (code, signal) => finish(new Error(`Dashboard exited (${code ?? signal}): ${output}`)));
      child.stderr.on("data", (data) => { output += data.toString(); });
      child.stdout.on("data", (data) => {
        output += data.toString();
        const match = output.match(/Dashboard running at (http:\/\/\S+)/);
        if (match) finish(null, new URL(match[1]));
      });
    });
    const headers = { Authorization: `Bearer ${address.searchParams.get("token")}` };
    const page = await fetch(new URL("/", address), { headers, signal: AbortSignal.timeout(5_000) });
    if (!page.ok || !page.headers.get("content-type")?.includes("text/html")) {
      throw new Error(`Dashboard page is unavailable: HTTP ${page.status}`);
    }
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map((match) => match[1]);
    if (!assets.some((asset) => asset.endsWith(".js")) || !assets.some((asset) => asset.endsWith(".css"))) {
      throw new Error("Dashboard HTML does not reference its JavaScript and CSS bundles.");
    }
    for (const asset of assets) {
      const response = await fetch(new URL(asset, address), { headers, signal: AbortSignal.timeout(5_000) });
      const expectedType = asset.endsWith(".js") ? "javascript" : "text/css";
      if (!response.ok || !response.headers.get("content-type")?.includes(expectedType) || !(await response.text()).length) {
        throw new Error(`Embedded dashboard asset is unavailable: ${asset} (HTTP ${response.status})`);
      }
    }
    const route = await fetch(new URL("/projects/smoke.project", address), { headers });
    if (!route.ok || await route.text() !== html) throw new Error("Dashboard SPA route did not serve index.html.");
    const missing = await fetch(new URL("/assets/missing.js", address), { headers });
    if (missing.status !== 404) throw new Error("Missing dashboard assets must return 404.");
    const unauthorized = await fetch(new URL("/", address));
    if (unauthorized.status !== 401) throw new Error("Dashboard assets must require authentication.");
    for (const key of ["projects", "workers", "runs"]) {
      const url = new URL(`/api/${key}`, address);
      url.search = address.search;
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`Dashboard ${key}: HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body[key])) throw new Error(`Dashboard ${key} did not return an array.`);
      if (key === "projects" && !body.projects.some((entry) => entry.root === project)) {
        throw new Error("Dashboard did not register the disposable project.");
      }
    }
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await closed;
    clearTimeout(timer);
  }
}

try {
  await copyFile(originalExecutable, executable);
  await chmod(executable, 0o755);
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

  await checkDashboard();

  await run(executable, ["once"], { cwd: project, timeout: 30_000, env: environment });
  const markerValue = JSON.parse(await readFile(marker, "utf8"));
  if (markerValue.item !== "SMOKE-1") throw new Error("The local plugin did not receive the discovered item.");
  const { stdout } = await run(executable, ["workflow", "runs", "--json"], { cwd: project, timeout: 30_000, env: environment });
  const runs = JSON.parse(stdout);
  if (!Array.isArray(runs) || !runs.some((entry) => entry.identity?.workflowId === "compiled" && entry.jobs?.plugin?.outputs?.verified === true)) {
    throw new Error("The workflow output was not persisted and readable after the compiled CLI restarted.");
  }
  console.log(JSON.stringify({ project: "disposable", dynamicPlugin: true, persistedWorkflow: true, dashboardRegistries: true, embeddedDashboard: true }));
} finally {
  await rm(project, { recursive: true, force: true });
}
