import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRepositoryIdentity, normalizeGitRemote } from "../src/state/repository-identity.js";

describe("normalizeGitRemote", () => {
  it.each([
    ["git@GitHub.COM:Acme/Relay.git", "github.com/Acme/Relay"],
    ["ssh://git@github.com/Acme/Relay.git", "github.com/Acme/Relay"],
    ["https://github.com/Acme/Relay.git", "github.com/Acme/Relay"],
    ["https://user:token@GITLAB.example/Org/Relay.git/", "gitlab.example/Org/Relay"],
  ])("normalizes %s", (input, expected) => expect(normalizeGitRemote(input)).toBe(expected));

  it("is deterministic for whitespace and empty values", () => {
    expect(normalizeGitRemote("  git@github.com:acme/relay.git  ")).toBe("github.com/acme/relay");
    expect(normalizeGitRemote("  ")).toBe("");
  });

  it("uses a canonical path identity outside Git repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-relay-repository-identity-"));
    const canonicalRoot = await realpath(root);
    await expect(getRepositoryIdentity(root)).resolves.toMatchObject({
      id: `path:${canonicalRoot}`,
      key: `path:${canonicalRoot}`,
      root: canonicalRoot,
      commonDir: canonicalRoot,
    });
  });
});
