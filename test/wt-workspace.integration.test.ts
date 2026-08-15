import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/domain/index.js";
import { WtWorkspaceProvider } from "../src/workspaces/wt-workspace-provider.js";

describe("WtWorkspaceProvider worktree root", () => {
  it("creates and removes a worktree under its generated Relay configuration", async (context) => {
    const available = await execa("wt", ["--version"], { reject: false });
    if (available.exitCode !== 0) return context.skip();

    const directory = await mkdtemp(path.join(tmpdir(), "task-relay-wt-"));
    const repository = path.join(directory, "repo");
    const worktreeRoot = path.join(repository, ".task-relay", "workspaces");
    try {
      await execa("git", ["init", "--initial-branch", "main", repository]);
      await execa("git", ["config", "user.email", "relay-test@example.invalid"], { cwd: repository });
      await execa("git", ["config", "user.name", "Task Relay Test"], { cwd: repository });
      await writeFile(path.join(repository, "README.md"), "# test\n");
      await execa("git", ["add", "README.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "initial"], { cwd: repository });

      const provider = new WtWorkspaceProvider({ worktreeRoot });
      const run = record(repository);
      const space = await provider.provision(run);

      expect(path.relative(worktreeRoot, space.path).startsWith("..")).toBe(false);
      expect(existsSync(space.path)).toBe(true);
      expect(existsSync(path.join(worktreeRoot, ".task-relay-worktrunk.toml"))).toBe(true);

      await provider.cleanup(space, run);
      expect(existsSync(space.path)).toBe(false);
      const branch = await execa("git", ["show-ref", "--verify", "--quiet", "refs/heads/relay/ENG-123"], { cwd: repository, reject: false });
      expect(branch.exitCode).not.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function record(repository: string): RunRecord {
  return {
    id: "run-1",
    identity: { repository: { id: "repo", root: repository }, sourceId: "linear", itemId: "ENG-123", triggerId: "implement" },
    item: { sourceId: "linear", id: "ENG-123", title: "Create isolated workspace", state: "open" },
    trigger: { id: "implement", sourceId: "linear", repository: { id: "repo", root: repository }, enabled: true, metadata: { branchTemplate: "relay/{{key}}" } },
    agent: { agentId: "codex" },
    status: "provisioning",
    claimedAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}
