import { describe, expect, it } from "vitest";
import { launchConfigSchema } from "../src/index.js";

describe("launch action package", () => {
  it("does not allow both inline and saved prompts", () => {
    expect(() => launchConfigSchema.parse({ harness: "codex", prompt: "hi", promptFile: "task.md" })).toThrow();
  });
});
