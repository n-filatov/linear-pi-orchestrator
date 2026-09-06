import { describe, expect, it } from "vitest";
import { createRunKey } from "../src/index.js";

describe("domain public API", () => {
  it("creates stable run identities without infrastructure", () => {
    expect(createRunKey({ repository: { id: "repo", root: "/repo" }, sourceId: "linear", itemId: "REL-1", triggerId: "ready" })).toContain("REL-1");
  });
});
