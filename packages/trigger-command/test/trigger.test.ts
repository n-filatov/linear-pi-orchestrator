import { describe, expect, it } from "vitest";
import { parseCommandItems } from "../src/index.js";

describe("command trigger package", () => {
  it("requires binding-scoped item identities", () => {
    expect(parseCommandItems(JSON.stringify({ items: [{ sourceId: "queue", id: "1", title: "Task" }] }), "queue")).toHaveLength(1);
    expect(() => parseCommandItems(JSON.stringify({ items: [{ sourceId: "other", id: "1", title: "Task" }] }), "queue")).toThrow(/unexpected sourceId/);
  });
});
