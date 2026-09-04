import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CanvasLayoutStore } from "../src/dashboard/canvas-layout-store.js";
import { WorkflowAlreadyExistsError, WorkflowConfigRepository, WorkflowRevisionConflictError, normalizeLegacyCodexTmuxNeeds } from "../src/dashboard/workflow-config-repository.js";

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "relay-workflow-config-"));
  await writeFile(join(root, ".task-relay.yaml"), `# project comment\nversion: 2\nproject: { name: demo }\nsources:\n  queue: { use: command }\nactions:\n  notify:\n    use: command\n    with: { command: node, args: [] }\nworkflows:\n  existing:\n    # workflow comment\n    on: { source: queue }\n    jobs:\n      one: { use: notify }\nworkspace: {}\nexecution: {}\nlogging: {}\n`);
  return root;
}

describe("WorkflowConfigRepository", () => {
  it("updates one workflow without removing comments or other workflows", async () => {
    const root = await project();
    const repository = new WorkflowConfigRepository(root);
    const before = await repository.get("existing");
    await repository.save("second", { on: { source: "queue" }, jobs: { two: { use: "notify" } } }, before.revision);
    const written = await readFile(join(root, ".task-relay.yaml"), "utf8");
    expect(written).toContain("# project comment");
    expect(written).toContain("# workflow comment");
    const config = parse(written) as { workflows: Record<string, unknown> };
    expect(Object.keys(config.workflows)).toEqual(["existing", "second"]);
  });

  it("refuses to overwrite an externally changed file", async () => {
    const root = await project();
    const repository = new WorkflowConfigRepository(root);
    const before = await repository.get("existing");
    await writeFile(join(root, ".task-relay.yaml"), `${await readFile(join(root, ".task-relay.yaml"), "utf8")}\n# external\n`);
    await expect(repository.save("existing", before.workflow, before.revision)).rejects.toBeInstanceOf(WorkflowRevisionConflictError);
  });

  it("creates atomically and refuses to overwrite an existing workflow id", async () => {
    const root = await project();
    const repository = new WorkflowConfigRepository(root);
    await expect(repository.create("existing", { on: { source: "queue" }, jobs: { one: { use: "notify" } } }))
      .rejects.toBeInstanceOf(WorkflowAlreadyExistsError);
  });

  it("stores canvas layout outside execution configuration", async () => {
    const root = await project();
    const layouts = new CanvasLayoutStore(root);
    await layouts.set("existing", { nodes: { trigger: { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1 } });
    await expect(layouts.get("existing")).resolves.toMatchObject({ nodes: { trigger: { x: 10, y: 20 } } });
    expect(await readFile(join(root, ".task-relay.ui.json"), "utf8")).toContain('"trigger"');
  });

  it("repairs the legacy truncated tmux dependency selected by a Codex action", async () => {
    const workflow = normalizeLegacyCodexTmuxNeeds({
      on: { source: "queue" },
      jobs: {
        "tmux.create-window-1": { use: "tmux.create-window" },
        "codex.start-session-2": {
          use: "codex.start-session",
          with: { prompt: "Work", tmux: { action: "tmux.create-window-1" } },
          needs: ["tmux.succeeded", "other.succeeded"],
        },
      },
    }) as any;
    expect(workflow.jobs["codex.start-session-2"].needs).toEqual(["other.succeeded", { job: "tmux.create-window-1", status: "started" }]);
  });

  it("repairs any unambiguous legacy dotted dependency before validation and persistence", async () => {
    const root = await project();
    const repository = new WorkflowConfigRepository(root);
    const before = await repository.get("existing");
    await repository.save("cleanup-flow", {
      on: { source: "queue" },
      jobs: {
        "tmux.create-window-1": { use: "notify" },
        cleanup: { use: "notify", needs: "tmux.succeeded" },
        report: { use: "notify", needs: { job: "tmux", status: "succeeded" } },
      },
    }, before.revision);

    const written = parse(await readFile(join(root, ".task-relay.yaml"), "utf8")) as any;
    expect(written.workflows["cleanup-flow"].jobs.cleanup.needs).toEqual({ job: "tmux.create-window-1", status: "succeeded" });
    expect(written.workflows["cleanup-flow"].jobs.report.needs).toEqual({ job: "tmux.create-window-1", status: "succeeded" });
  });

  it("does not guess an ambiguous dependency or overwrite an exact job id", () => {
    const workflow = normalizeLegacyCodexTmuxNeeds({
      on: { source: "queue" },
      jobs: {
        tmux: { use: "notify" },
        "tmux.create-window-1": { use: "notify" },
        "tmux.other-window": { use: "notify" },
        "agent.one": { use: "notify" },
        "agent.two": { use: "notify" },
        exact: { use: "notify", needs: "tmux.succeeded" },
        ambiguous: { use: "notify", needs: { job: "agent", status: "succeeded" } },
      },
    }) as any;

    expect(workflow.jobs.exact.needs).toBe("tmux.succeeded");
    expect(workflow.jobs.ambiguous.needs).toEqual({ job: "agent", status: "succeeded" });
  });

  it("preserves a canonical dotted dependency by converting it to an unambiguous object need", () => {
    const workflow = normalizeLegacyCodexTmuxNeeds({
      on: { source: "queue" },
      jobs: {
        "tmux.create-window-1": { use: "notify" },
        cleanup: { use: "notify", needs: "tmux.create-window-1.succeeded" },
      },
    }) as any;

    expect(workflow.jobs.cleanup.needs).toEqual({ job: "tmux.create-window-1", status: "succeeded" });
  });
});
