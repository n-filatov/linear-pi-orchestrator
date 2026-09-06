import { writeFile } from "node:fs/promises";

// Preserve the public npm entry points while tsc emits the workspace tree.
for (const entry of ["index", "plugin"]) {
  for (const extension of ["js", "d.ts"]) {
    await writeFile(new URL(`../dist/${entry}.${extension}`, import.meta.url), `export * from "./src/${entry}.js";\n`);
  }
}
