import { describe, expect, it } from "vitest";
import { parseCommandItems } from "../src/sources/command-source.js";

describe("command source protocol", () => {
  it("parses canonical items and enforces the configured source id", () => {
    const items = parseCommandItems(JSON.stringify({ items: [{ sourceId: "queue", id: "A-1", title: "Do work", state: "open" }] }), "queue");
    expect(items[0]).toMatchObject({ sourceId: "queue", id: "A-1", title: "Do work" });
    expect(() => parseCommandItems(JSON.stringify({ items: [{ sourceId: "other", id: "A-1", title: "Do work" }] }), "queue")).toThrow(/unexpected sourceId/);
  });
});
