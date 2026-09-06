import { describe, expect, it } from "vitest";
import { fixtureAction, registryWith } from "../src/index.js";

describe("plugin fixture", () => {
  it("uses the same host registration validation as shipped plugins", () => {
    const plugin = fixtureAction();
    expect(registryWith(plugin).parseActionConfig(plugin.use, { value: "ok" })).toEqual({ value: "ok" });
  });
});
