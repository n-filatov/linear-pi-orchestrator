import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayProgram } from "../src/cli/program.js";
import type { RunRecord } from "../src/domain/types.js";
import { GlobalWorkerRegistry } from "../src/state/global-worker-registry.js";

const originalStateHome = process.env.XDG_STATE_HOME;
afterEach(() => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
});

function record(root: string): RunRecord {
  const repository = { id: "github.com/acme/crm", root };
  return {
    id: "run-CRM-539",
    identity: { repository, sourceId: "linear", itemId: "linear-539", triggerId: "implement" },
    item: { sourceId: "linear", id: "linear-539", title: "Persist worker lookup", metadata: { identifier: "CRM-539" } },
    trigger: { id: "implement", sourceId: "linear", repository, enabled: true },
    agent: { agentId: "codex", model: "gpt-5.6-terra" },
    status: "running",
    claimedAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:01:00.000Z",
    workspace: { path: join(root, ".task-relay/workspaces/CRM-539"), branch: "relay/CRM-539" },
    worker: { id: "legacy-worker-id", startedAt: "2026-08-27T12:00:01.000Z", metadata: { tmux: { session: "task-relay-crm", window: "CRM-539", target: "@15" } } },
  };
}

async function run(cwd: string, ...args: string[]): Promise<string> {
  const stdout = new PassThrough();
  const output: string[] = [];
  stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const program = createRelayProgram({ stdout: stdout as unknown as NodeJS.WriteStream, cwd: () => cwd });
  await program.parseAsync(["node", "relay", ...args]);
  return output.join("");
}

describe("global worker CLI", () => {
  it("finds an issue outside its repository after the originating Relay process exits", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-global-cli-state-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "task-relay-global-cli-cwd-"));
    process.env.XDG_STATE_HOME = stateHome;
    try {
      const registry = new GlobalWorkerRegistry();
      const stored = registry.upsertRun(record("/projects/crm"));
      registry.close();

      const shown = JSON.parse(await run(elsewhere, "worker", "show", "CRM-539", "--json")) as { id: string; repository: { id: string }; runtime: { tmuxWindow: string } };
      expect(shown).toMatchObject({ id: stored.id, repository: { id: "github.com/acme/crm" }, runtime: { tmuxWindow: "CRM-539" } });
      expect(await run(elsewhere, "worker", "list")).toContain("CRM-539");
    } finally {
      await rm(stateHome, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("resolves attach commands to the owning repository when invoked elsewhere", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "task-relay-global-attach-state-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "task-relay-global-attach-cwd-"));
    const repositoryRoot = await mkdtemp(join(tmpdir(), "task-relay-global-attach-repo-"));
    process.env.XDG_STATE_HOME = stateHome;
    try {
      await writeFile(join(repositoryRoot, ".task-relay.yaml"), [
        "version: 2", "project: { name: crm }", "sources: {}", "harnesses: {}", "actions: {}", "triggers: []",
        "logging: { level: silent, pretty: false }", "",
      ].join("\n"));
      const registry = new GlobalWorkerRegistry();
      registry.upsertRun(record(repositoryRoot));
      registry.close();

      let resolvedRoot: string | undefined;
      const program = createRelayProgram({
        cwd: () => elsewhere,
        handlers: { attach: async (context) => { resolvedRoot = context.projectRoot; } },
      });
      await program.parseAsync(["node", "relay", "attach", "CRM-539"]);
      expect(resolvedRoot).toBe(await realpath(repositoryRoot));
    } finally {
      await rm(stateHome, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
});
