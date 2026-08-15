import { describe, expect, it, beforeEach, vi } from "vitest";
import { execa } from "execa";
import type { RunRecord, Workspace } from "../src/domain/index.js";

vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));

import { GitWorktreeProvider } from "../src/workspaces/git-worktree-provider.js";
import { WtWorkspaceProvider } from "../src/workspaces/wt-workspace-provider.js";
import { isWithinWorkspaceRoot } from "../src/workspaces/worktree-utils.js";

const repository = "/repo/project";
const workspaceRoot = "/repo/project/.task-relay/workspaces";
const wtConfigPath = `${workspaceRoot}/.task-relay-worktrunk.toml`;
const branch = "relay/ENG-123";

function run(): RunRecord {
  return {
    id: "run-1",
    identity: { repository: { id: "project", root: repository }, sourceId: "linear", itemId: "ENG-123", triggerId: "implement" },
    item: { sourceId: "linear", id: "ENG-123", title: "Implement ownership checks", state: "open" },
    trigger: { id: "implement", sourceId: "linear", repository: { id: "project", root: repository }, enabled: true, metadata: { branchTemplate: "relay/{{key}}" } },
    agent: { agentId: "codex" },
    status: "provisioning",
    claimedAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}

function command(stdout = "", exitCode = 0): never {
  return { stdout, exitCode } as never;
}

const mockExeca = vi.mocked(execa);

beforeEach(() => mockExeca.mockReset());

function wasCalled(file: string, expectedArgs: readonly string[]): boolean {
  return mockExeca.mock.calls.some((call) => call[0] === file && Array.isArray(call[1]) && call[1].every((value, index) => value === expectedArgs[index]) && call[1].length === expectedArgs.length);
}

describe("GitWorktreeProvider cleanup ownership", () => {
  it("removes a Relay-created worktree and its Relay-created branch", async () => {
    mockExeca
      .mockResolvedValueOnce(command("worktree /repo/project\nbranch refs/heads/main\n"))
      .mockResolvedValueOnce(command("", 1))
      .mockResolvedValueOnce(command("", 1))
      .mockResolvedValueOnce(command("main"))
      .mockResolvedValueOnce(command(""));
    const provider = new GitWorktreeProvider({ worktreeRoot: workspaceRoot });
    const space = await provider.provision(run());

    expect(space.metadata?.taskRelay).toEqual({ createdWorkspace: true, createdBranch: true, worktreeRoot: workspaceRoot });

    mockExeca.mockResolvedValueOnce(command(""))
      .mockResolvedValueOnce(command("", 0))
      .mockResolvedValueOnce(command(""));
    await provider.cleanup(space, run());

    expect(mockExeca).toHaveBeenCalledWith("git", ["worktree", "remove", "--force", `${workspaceRoot}/relay-ENG-123`], { cwd: repository, reject: false });
    expect(mockExeca).toHaveBeenCalledWith("git", ["branch", "-D", branch], { cwd: repository });
  });

  it("preserves an adopted worktree and branch", async () => {
    const adoptedPath = "/repo/project.user-worktrees/relay-ENG-123";
    mockExeca.mockResolvedValueOnce(command(`worktree ${adoptedPath}\nbranch refs/heads/${branch}\n`));
    const provider = new GitWorktreeProvider({ worktreeRoot: workspaceRoot });
    const space = await provider.provision(run());

    expect(space.metadata?.taskRelay).toEqual({ createdWorkspace: false, createdBranch: false, worktreeRoot: workspaceRoot });
    await expect(provider.cleanup(space, run())).rejects.toThrow(/adopted workspace/);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it("removes its new worktree without deleting an adopted branch", async () => {
    mockExeca
      .mockResolvedValueOnce(command("worktree /repo/project\nbranch refs/heads/main\n"))
      .mockResolvedValueOnce(command("", 0))
      .mockResolvedValueOnce(command(""));
    const provider = new GitWorktreeProvider({ worktreeRoot: workspaceRoot });
    const space = await provider.provision(run());

    expect(space.metadata?.taskRelay).toEqual({ createdWorkspace: true, createdBranch: false, worktreeRoot: workspaceRoot });
    mockExeca.mockResolvedValueOnce(command(""));
    await provider.cleanup(space, run());

    expect(mockExeca).toHaveBeenCalledWith("git", ["worktree", "remove", "--force", `${workspaceRoot}/relay-ENG-123`], { cwd: repository, reject: false });
    expect(wasCalled("git", ["branch", "-D", branch])).toBe(false);
  });

  it("refuses cleanup when an owned record points outside the configured root", async () => {
    const provider = new GitWorktreeProvider({ worktreeRoot: workspaceRoot });
    const outside: Workspace = {
      path: "/repo/project.user-worktrees/relay-ENG-123",
      branch,
      metadata: { repository, provider: "git-worktree", taskRelay: { createdWorkspace: true, createdBranch: true, worktreeRoot: workspaceRoot } },
    };

    await expect(provider.cleanup(outside, run())).rejects.toThrow(/outside the configured Relay workspace root/);
    expect(mockExeca).not.toHaveBeenCalled();
  });
});

describe("WtWorkspaceProvider cleanup ownership", () => {
  it("records ownership for a newly created wt workspace and lets wt remove it", async () => {
    mockExeca
      .mockResolvedValueOnce(command("[]"))
      .mockResolvedValueOnce(command("", 1))
      .mockResolvedValueOnce(command("", 1))
      .mockResolvedValueOnce(command("main"))
      .mockResolvedValueOnce(command(JSON.stringify({ worktree_path: `${workspaceRoot}/relay-ENG-123` })));
    const provider = new WtWorkspaceProvider({ worktreeRoot: workspaceRoot });
    const space = await provider.provision(run());

    expect(space.metadata?.taskRelay).toEqual({ createdWorkspace: true, createdBranch: true, worktreeRoot: workspaceRoot });
    mockExeca.mockResolvedValueOnce(command(""));
    await provider.cleanup(space, run());

    expect(mockExeca).toHaveBeenCalledWith("wt", ["--config", wtConfigPath, "-C", repository, "remove", branch, "--force", "-D", "--foreground", "-y", "--no-hooks"], { reject: false });
  });

  it("uses native Git for a Relay-created wt worktree on an adopted branch", async () => {
    mockExeca
      .mockResolvedValueOnce(command("[]"))
      .mockResolvedValueOnce(command("", 0))
      .mockResolvedValueOnce(command(JSON.stringify({ worktree_path: `${workspaceRoot}/relay-ENG-123` })));
    const provider = new WtWorkspaceProvider({ worktreeRoot: workspaceRoot });
    const space = await provider.provision(run());
    mockExeca.mockResolvedValueOnce(command(""));
    await provider.cleanup(space, run());

    expect(mockExeca).toHaveBeenCalledWith("git", ["worktree", "remove", "--force", `${workspaceRoot}/relay-ENG-123`], { cwd: repository, reject: false });
    expect(wasCalled("wt", ["--config", wtConfigPath, "-C", repository, "remove", branch, "--force", "-D", "--foreground", "-y", "--no-hooks"])).toBe(false);
    expect(wasCalled("git", ["branch", "-D", branch])).toBe(false);
  });

  it("does not clean up a wt worktree it discovered", async () => {
    mockExeca.mockResolvedValueOnce(command(JSON.stringify([{ branch, path: `${workspaceRoot}/relay-ENG-123` }])));
    const provider = new WtWorkspaceProvider({ worktreeRoot: workspaceRoot });
    const space = await provider.provision(run());

    await expect(provider.cleanup(space, run())).rejects.toThrow(/adopted workspace/);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it("refuses a wt result outside the configured Relay workspace root", async () => {
    mockExeca
      .mockResolvedValueOnce(command("[]"))
      .mockResolvedValueOnce(command("", 0))
      .mockResolvedValueOnce(command(JSON.stringify({ worktree_path: "/repo/project.user-worktrees/relay-ENG-123" })));
    const provider = new WtWorkspaceProvider({ worktreeRoot: workspaceRoot });

    await expect(provider.provision(run())).rejects.toThrow(/outside the configured Relay workspace root/);
    expect(wasCalled("wt", ["--config", wtConfigPath, "-C", repository, "remove", branch, "--force", "-D", "--foreground", "-y", "--no-hooks"])).toBe(false);
  });
});

describe("workspace root containment", () => {
  it("accepts children only, including normalized child paths", () => {
    expect(isWithinWorkspaceRoot(`${workspaceRoot}/relay-ENG-123`, workspaceRoot)).toBe(true);
    expect(isWithinWorkspaceRoot(`${workspaceRoot}/nested/../relay-ENG-123`, workspaceRoot)).toBe(true);
    expect(isWithinWorkspaceRoot(workspaceRoot, workspaceRoot)).toBe(false);
    expect(isWithinWorkspaceRoot("/repo/project/.task-relay/other/relay-ENG-123", workspaceRoot)).toBe(false);
    expect(isWithinWorkspaceRoot(`${workspaceRoot}/../escape`, workspaceRoot)).toBe(false);
  });
});
