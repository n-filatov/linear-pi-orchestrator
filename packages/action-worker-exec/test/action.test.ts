import { describe, expect, it } from "vitest";
import { workerExecConfigSchema } from "../src/index.js";
describe("worker exec action", () => it("defaults to the current worker and a pane", () => {
  expect(workerExecConfigSchema.parse({ command: "npm" })).toMatchObject({ open: "pane", direction: "vertical", worker: { sourceItem: "current", runs: "latest" } });
}));
