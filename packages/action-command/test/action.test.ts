import { describe, expect, it } from "vitest";
import { commandConfigSchema } from "../src/index.js";

describe("command action package", () => {
  it("rejects shell-shaped configuration outside its explicit executable fields", () => {
    expect(commandConfigSchema.parse({ command: "git" })).toMatchObject({ args: [], environment: {} });
    expect(() => commandConfigSchema.parse({ command: "git", shell: true })).toThrow();
  });
});
