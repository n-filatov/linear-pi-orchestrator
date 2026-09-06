import { describe, expect, it } from "vitest";
import { assertPluginJson } from "../src/index.js";

describe("plugin SDK public API", () => {
  it("rejects non-persistable plugin output", () => {
    expect(() => assertPluginJson({ value: Number.NaN })).toThrow("finite number");
  });
});
