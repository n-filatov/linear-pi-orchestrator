import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { target: { type: "string" }, outfile: { type: "string" } } });
if (!values.target || !values.outfile) throw new Error("Usage: bun scripts/compile-cli.mjs --target bun-<platform>-<arch> --outfile <binary>");
const assetRoot = join(root, "dist/dashboard-client");
const assets = [];
async function collect(directory, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collect(join(directory, entry.name), `${name}/`);
    else if (entry.isFile()) assets.push([name, (await readFile(join(directory, entry.name))).toString("base64")]);
    else throw new Error(`Unsupported dashboard asset: ${name}`);
  }
}
await collect(assetRoot);
if (!assets.some(([name]) => name === "index.html")) throw new Error("Build the dashboard with npm run dashboard:build before compiling the CLI.");

const result = await Bun.build({
  entrypoints: [join(root, "src/cli/main.ts")],
  target: "bun",
  compile: { target: values.target, outfile: resolve(values.outfile) },
  external: ["@nestjs/microservices", "@nestjs/platform-express", "@nestjs/websockets", "class-transformer", "class-validator"],
  plugins: [{
    name: "embed-dashboard-assets",
    setup(build) {
      build.onLoad({ filter: /[/\\]dashboard[/\\]embedded-assets\.ts$/ }, () => ({
        loader: "js",
        contents: `export const embeddedDashboardAssets = new Map(${JSON.stringify(assets)}.map(([name, data]) => [name, Buffer.from(data, "base64")]));`,
      }));
    },
  }],
});
if (!result.success) throw new AggregateError(result.logs, "Native CLI compilation failed");
console.log(`Compiled ${values.outfile} with ${assets.length} embedded dashboard assets.`);
