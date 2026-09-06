import { describe, expect, it } from "vitest";
import { mergeConfigDocuments } from "../src/index.js";

describe("mergeConfigDocuments", () => {
  it("merges nested YAML-shaped records without mutating the base", () => {
    const base = { source: { enabled: true, labels: ["ready"] } };
    expect(mergeConfigDocuments(base, { source: { enabled: false } })).toEqual({ source: { enabled: false, labels: ["ready"] } });
    expect(base.source.enabled).toBe(true);
  });
});
