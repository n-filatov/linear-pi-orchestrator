import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayCommandContext } from "../src/cli/program.js";
import { GlobalRuntimeSupervisor } from "../src/dashboard/runtime-supervisor.js";

const originalStateHome = process.env.XDG_STATE_HOME;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
});

describe("GlobalRuntimeSupervisor", () => {
  it("ticks enabled projects and releases their lease", async () => {
    process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "relay-supervisor-state-"));
    const root = await mkdtemp(join(tmpdir(), "relay-supervisor-project-"));
    const once = vi.fn(async () => undefined);
    const context = {
      projectRoot: root,
      config: { sources: { queue: { enabled: true, pollIntervalMs: 60_000 } } },
    } as unknown as RelayCommandContext;
    const projects = {
      listProjects: async () => [{ id: "folder-1", root, enabled: true }],
      context: async () => context,
    };
    const supervisor = new GlobalRuntimeSupervisor(projects, { once });
    expect((await supervisor.start("folder-1")).state).toBe("running");
    expect(once).toHaveBeenCalledOnce();
    expect(supervisor.status("folder-1")[0]?.nextTickAt).toBeTruthy();
    expect((await supervisor.stop("folder-1")).state).toBe("stopped");
  });
});
