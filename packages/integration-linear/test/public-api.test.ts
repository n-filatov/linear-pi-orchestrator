import { describe, expect, it } from "vitest";
import { readMcpJson } from "../src/index.js";

describe("Linear integration public API", () => {
  it("parses JSON text without exposing transport state", () => {
    expect(readMcpJson({ content: [{ type: "text", text: '{"ok":true}' }] })).toEqual({ ok: true });
  });
});
