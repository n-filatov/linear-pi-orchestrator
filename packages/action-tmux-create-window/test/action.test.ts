import { describe, expect, it } from "vitest";
import { tmuxCreateWindowConfigSchema } from "../src/index.js";
describe("tmux create-window action", () => it("has no free-form configuration", () => {
  expect(tmuxCreateWindowConfigSchema.parse(undefined)).toEqual({});
  expect(() => tmuxCreateWindowConfigSchema.parse({ pane: "unsafe" })).toThrow();
}));
