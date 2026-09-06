import { describe, expect, it } from "vitest";
import { isLinearTriggerSelector, parseLinearTriggerSelector } from "../src/index.js";

describe("Linear trigger selector", () => {
  it("retains supported legacy aliases and ignores unknown fields", () => {
    expect(parseLinearTriggerSelector({ label: "ready", excludeLabels: ["blocked"] })).toMatchObject({ label: "ready", excludeLabels: ["blocked"] });
    expect(isLinearTriggerSelector({ labels: { any: ["ready"] } })).toBe(true);
    expect(isLinearTriggerSelector({ unexpected: true })).toBe(true);
  });
});
