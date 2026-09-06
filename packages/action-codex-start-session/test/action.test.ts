import { describe, expect, it } from "vitest";
import { codexStartSessionConfigSchema } from "../src/index.js";
describe("Codex start-session action", () => it("requires one prompt source", () => {
  expect(() => codexStartSessionConfigSchema.parse({})).toThrow();
  expect(codexStartSessionConfigSchema.parse({ prompt: "implement" })).toMatchObject({ prompt: "implement" });
}));
