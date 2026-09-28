import { describe, expect, it } from "vitest";
import { claudeAppInstalled, claudeAuthStatusRow } from "../src/cli/program.js";

describe("relay doctor Claude checks", () => {
  it("reports logged in when 'claude auth status' returns loggedIn true", async () => {
    expect(await claudeAuthStatusRow(() => JSON.stringify({ loggedIn: true }))).toBe("logged in");
  });

  it("reports not logged in when loggedIn is false", async () => {
    expect(await claudeAuthStatusRow(() => JSON.stringify({ loggedIn: false }))).toBe("not logged in — run 'claude auth login'");
  });

  it("reports claude not found when the command fails", async () => {
    expect(await claudeAuthStatusRow(() => { throw new Error("spawn claude ENOENT"); })).toBe("claude not found");
  });

  it("reports claude not found when the output is not valid JSON", async () => {
    expect(await claudeAuthStatusRow(() => "not json")).toBe("claude not found");
  });

  it("detects the Claude app in either Applications directory", () => {
    expect(claudeAppInstalled((path) => path === "/Applications/Claude.app")).toBe(true);
    expect(claudeAppInstalled((path) => path.endsWith("Applications/Claude.app") && path !== "/Applications/Claude.app")).toBe(true);
    expect(claudeAppInstalled(() => false)).toBe(false);
  });
});
