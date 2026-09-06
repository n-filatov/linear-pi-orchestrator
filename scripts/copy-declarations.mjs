#!/usr/bin/env node
// tsc does not copy hand-written .d.ts inputs into outDir. Relay declares
// ambient modules for dependencies that ship no types, and a consumer of the
// published package needs those declarations next to the emitted output.
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src");
const destination = path.join(root, "dist", "src");

async function copyDeclarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const from = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await copyDeclarations(from);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    const to = path.join(destination, path.relative(source, from));
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
  }
}

await copyDeclarations(source);

// Package manifests expose dist/index.js at runtime. tsc emits those files in
// the root dist tree, so copy each package's public output next to its manifest
// after every build. This keeps Node and the compiled-release smoke from ever
// importing workspace TypeScript directly.
for (const entry of await readdir(path.join(root, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const from = path.join(root, "dist", "packages", entry.name, "src");
  if (!existsSync(from)) continue;
  const to = path.join(root, "packages", entry.name, "dist");
  await cp(from, to, { recursive: true, force: true });
}
