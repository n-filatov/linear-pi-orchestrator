import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  plugins: [{
    name: "relay-workspace-source",
    enforce: "pre",
    resolveId(id) {
      const name = /^@task-relay\/([^/]+)$/.exec(id)?.[1];
      return name ? path.resolve(__dirname, "packages", name, "src", "index.ts") : null;
    },
  }],
  test: {
    include: ["test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.task-relay/**"],
  },
});
