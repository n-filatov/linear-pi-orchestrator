import { describe, expect, it } from "vitest";
import { codexSendPromptConfigSchema } from "../src/index.js";
describe("Codex send-prompt action", () => it("prevents ambiguous prompt input", () => {
  expect(() => codexSendPromptConfigSchema.parse({ codex: { action: "start" }, prompt: "a", promptFile: "a.md" })).toThrow();
  expect(codexSendPromptConfigSchema.parse({ codex: { action: "start" }, prompt: "a" }).delivery).toBe("idle");
}));
