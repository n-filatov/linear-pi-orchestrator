import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { createRuntimeHandlers } from "../src/app.js";
import { loadRelayConfig } from "../src/config/load.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { createEventLogger, eventLogPath } from "../src/logging/events.js";
import { RepositoryStateStore } from "../src/state/store.js";
import type { WorkItem } from "../src/domain/index.js";

const originalStateHome = process.env.XDG_STATE_HOME;
afterEach(() => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
});

const item: WorkItem = { sourceId: "queue", id: "ENG-4", title: "Dashboard task" };

async function dashboard(document: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "task-relay-dashboard-"));
  process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "task-relay-dashboard-state-"));
  await writeFile(join(root, ".task-relay.yaml"), stringify(document));
  const loaded = await loadRelayConfig(root);
  const context = {
    projectRoot: loaded.projectRoot,
    config: loaded.config,
    store: new RepositoryStateStore(loaded.projectRoot),
    logger: createEventLogger(loaded.projectRoot, "info", false),
    write: () => {},
  };
  const server = new DashboardServer(context, createRuntimeHandlers());
  const url = await server.start(0);
  return {
    root, url, context, server,
    get: (path: string) => fetch(`${url}${path}`).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, never> })),
    post: (path: string, body?: unknown) => fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, never> })),
    put: (path: string, body: unknown) => fetch(`${url}${path}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: await response.json() as Record<string, never> })),
  };
}

const workflowProject = {
  version: 2,
  project: { name: "dashboard-test" },
  sources: { queue: { uses: "command", with: { discover: { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'ENG-4',title:'Dashboard task'}]}))"] } } } },
  actions: { notify: { uses: "command", with: { command: process.execPath, args: ["-e", "0"] } } },
  workflows: {
    feature: {
      on: { source: "queue" },
      jobs: {
        one: { uses: "notify" },
        two: { uses: "notify", needs: "one.Started", if: "${{ always() }}", continueOnError: true },
      },
    },
  },
  logging: { level: "silent", pretty: false },
};

describe("dashboard API", () => {
  it("serves workflows with their declared jobs and persisted run state", async () => {
    const app = await dashboard(workflowProject);
    try {
      const repository = { id: "dashboard-test", root: app.context.projectRoot };
      const identity = { repository, workflowId: "feature", sourceId: "queue", itemId: "ENG-4", occurrence: "item" };
      await app.context.store.openWorkflowRun({ identity, item, startedAt: "2026-08-19T10:00:00.000Z" });
      await app.context.store.updateWorkflowJob(identity, "one", { status: "started", workerId: "ENG-4:codex", at: "2026-08-19T10:00:01.000Z" });

      const { body } = await app.get("/api/workflows");
      const [workflow] = body.workflows as unknown as Record<string, never>[];
      expect(workflow.id).toBe("feature");
      expect(workflow.source).toBe("queue");
      expect((workflow.jobs as unknown as Record<string, never>[]).map((job) => job.id)).toEqual(["one", "two"]);
      // The UI needs the raw need and condition to explain why a job waits.
      expect((workflow.jobs as unknown as Record<string, never>[])[1]).toMatchObject({ needs: ["one.Started"], if: "${{ always() }}", continueOnError: true });
      const runs = workflow.runs as unknown as Record<string, never>[];
      expect(runs).toHaveLength(1);
      expect((runs[0].jobs as unknown as Record<string, never>).one).toMatchObject({ status: "started", workerId: "ENG-4:codex" });
    } finally { await app.server.stop(); }
  });

  it("preserves the workflows block when the form editor saves", async () => {
    const app = await dashboard(workflowProject);
    try {
      // The form models sources, actions and triggers but not workflows. A save
      // that dropped what it cannot edit would silently delete a whole block.
      const { body: loaded } = await app.get("/api/config/json");
      const config = loaded.config as unknown as Record<string, unknown>;
      expect(Object.keys(config.workflows as object)).toEqual(["feature"]);

      const saved = await app.put("/api/config/json", { config });
      expect(saved.body.ok).toBe(true);

      const written = parse(await readFile(join(app.root, ".task-relay.yaml"), "utf8")) as {
        workflows: Record<string, { jobs: Record<string, { needs?: unknown }> }>;
      };
      expect(Object.keys(written.workflows)).toEqual(["feature"]);
      expect(written.workflows.feature.jobs.two.needs).toBe("one.Started");
    } finally { await app.server.stop(); }
  });

  it("runs a workflow dry run and reports an unknown workflow", async () => {
    const app = await dashboard(workflowProject);
    try {
      const ok = await app.post("/api/workflows/feature/test");
      expect(ok.body.ok).toBe(true);
      expect(ok.body.output).toContain("Workflow: feature");
      expect(ok.body.output).toContain("ENG-4");

      const missing = await app.post("/api/workflows/nope/test");
      expect(missing.status).toBe(400);
      expect(missing.body.error).toMatch(/Unknown workflow/);
    } finally { await app.server.stop(); }
  });

  it("dry-runs a workflow even when an unrelated action needs an uninstalled plugin", async () => {
    const app = await dashboard({
      ...workflowProject,
      actions: { ...workflowProject.actions, ghost: { uses: "@nobody/relay-absent", with: {} } },
      triggers: [{ id: "unrelated", source: "queue", actions: ["ghost"] }],
    });
    try {
      // Only the selected workflow's plugins are loaded, so a missing plugin
      // somewhere else in the file cannot break this dry run.
      const { body } = await app.post("/api/workflows/feature/test");
      expect(body.ok).toBe(true);
      expect(body.output).toContain("Workflow: feature");

      // The unrelated trigger still fails on its own, and says why.
      const broken = await app.post("/api/workflows/unrelated/test");
      expect(broken.body.error).toMatch(/Unknown workflow 'unrelated'/);
    } finally { await app.server.stop(); }
  });

  it("reports plugin health for what the configuration references", async () => {
    const app = await dashboard({
      ...workflowProject,
      actions: { ...workflowProject.actions, custom: { uses: "@nobody/relay-absent", with: {} } },
      triggers: [{ id: "ready", source: "queue", actions: ["custom"] }],
    });
    try {
      const { body } = await app.get("/api/plugins");
      expect(body.directory).toMatch(/task-relay\/plugins$/);
      const referenced = body.referenced as unknown as Record<string, never>[];
      const absent = referenced.find((entry) => entry.use === "@nobody/relay-absent");
      expect(absent).toMatchObject({ state: "not-installed", locations: ["actions.custom"] });
    } finally { await app.server.stop(); }
  });

  it("serves a JSON Schema that describes workflows", async () => {
    const app = await dashboard(workflowProject);
    try {
      const { body } = await app.get("/api/config/schema");
      expect(Object.keys(body.properties as object)).toContain("workflows");
    } finally { await app.server.stop(); }
  });

  it("refuses worker control when the execution adapter cannot provide it", async () => {
    const app = await dashboard({ ...workflowProject, execution: { adapter: "process" } });
    try {
      const sent = await app.post("/api/workers/ENG-4:codex/send", { text: "hello" });
      expect(sent.status).toBe(400);
      // No worker exists yet, so the missing worker is reported before the adapter.
      expect(sent.body.error).toMatch(/No worker found|execution\.adapter: tmux/);

      const empty = await app.post("/api/workers/ENG-4:codex/send", { text: "   " });
      expect(empty.body.error).toBe("Nothing to send.");

      const noCommand = await app.post("/api/workers/ENG-4:codex/exec", { command: "" });
      expect(noCommand.body.error).toBe("A command is required.");
    } finally { await app.server.stop(); }
  });

  it("streams appended log lines over server-sent events", async () => {
    const app = await dashboard(workflowProject);
    try {
      const response = await fetch(`${app.url}/api/events`);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      await appendFile(eventLogPath(app.context.projectRoot), `${JSON.stringify({ level: 30, time: "2026-08-19T10:00:00.000Z", task: "ENG-4", msg: "streamed" })}\n`);

      let seen = "";
      const deadline = Date.now() + 8_000;
      while (!seen.includes("streamed") && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        seen += decoder.decode(chunk.value);
      }
      expect(seen).toContain("streamed");
      await reader.cancel();
    } finally { await app.server.stop(); }
  });
});
