import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createRuntimeHandlers } from "../src/app.js";
import { GlobalDashboardServer } from "../src/dashboard/global-server.js";
import { ProjectManager } from "../src/dashboard/project-manager.js";

const originalStateHome = process.env.XDG_STATE_HOME;
afterEach(() => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
});

describe("GlobalDashboardServer", () => {
  it("keeps dotted client-route IDs on the SPA fallback while missing assets return 404", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "relay-global-dashboard-static-state-"));
    process.env.XDG_STATE_HOME = stateHome;
    const projects = new ProjectManager({ stateHome });
    const server = new GlobalDashboardServer(projects, {});
    const authenticated = new URL(await server.start(0));
    const token = authenticated.searchParams.get("token")!;
    try {
      const redirect = await fetch(new URL(`/projects/repo/workflows/release.1?token=${token}&tab=canvas`, authenticated), { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/projects/repo/workflows/release.1?tab=canvas");
      const cookie = redirect.headers.get("set-cookie")!.split(";", 1)[0];

      const deepLink = await fetch(new URL("/projects/repo/workflows/release.1", authenticated), { headers: { cookie } });
      expect(deepLink.status).not.toBe(404);
      const missingAsset = await fetch(new URL("/assets/not-found.js", authenticated), { headers: { cookie } });
      expect(missingAsset.status).toBe(404);
    } finally {
      await server.stop();
      projects.close();
    }
  });

  it("tests an unsaved workflow draft without changing the repository YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-global-dashboard-draft-"));
    const stateHome = await mkdtemp(join(tmpdir(), "relay-global-dashboard-draft-state-"));
    process.env.XDG_STATE_HOME = stateHome;
    const discover = "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'ENG-1',title:'Draft ticket'}]}))";
    await writeFile(join(root, ".task-relay.yaml"), stringify({
      version: 2,
      project: { name: "draft-test" },
      sources: { queue: { use: "command", with: { discover: { command: process.execPath, args: ["-e", discover] } } } },
      actions: { notify: { use: "command", with: { command: process.execPath, args: ["-e", "process.exit(0)"] } } },
      workflows: { delivery: { on: { source: "queue" }, jobs: { notify: { use: "notify" } } } },
      logging: { level: "silent", pretty: false },
    }));
    const before = await readFile(join(root, ".task-relay.yaml"), "utf8");
    const projects = new ProjectManager({ stateHome });
    const project = await projects.register(root);
    const server = new GlobalDashboardServer(projects, createRuntimeHandlers());
    const authenticated = new URL(await server.start(0));
    const request = (body?: unknown) => fetch(new URL(`/api/projects/${project.id}/workflows/delivery/actions/notify/test?token=${authenticated.searchParams.get("token")}`, authenticated), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      const saved = await request();
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ result: { triggerMatchCount: 1, eligibleCount: 1, items: [{ id: "ENG-1", eligible: true }] } });

      const draft = {
        enabled: true,
        on: { source: "queue", match: {}, fire: { policy: "once-per-match" } },
        jobs: { notify: { use: "notify", if: "${{ false }}", continueOnError: false, enabled: true } },
      };
      const preview = await request({ workflow: draft, action: { id: "notify", use: "notify" } });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ result: {
        workflowId: "delivery", actionId: "notify", triggerMatchCount: 1, eligibleCount: 0,
        items: [{ id: "ENG-1", eligible: false, decision: "settle", reason: "if evaluated false" }],
      } });
      expect(await readFile(join(root, ".task-relay.yaml"), "utf8")).toBe(before);
    } finally {
      await server.stop();
      projects.close();
    }
  });

  it("serves registered folders and revision-checked workflow and layout APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-global-dashboard-project-"));
    const stateHome = await mkdtemp(join(tmpdir(), "relay-global-dashboard-state-"));
    process.env.XDG_STATE_HOME = stateHome;
    await writeFile(join(root, ".task-relay.yaml"), `# preserved project comment
version: 2
project: { name: dashboard-test }
sources:
  queue: { use: command }
actions:
  notify:
    use: command
    with: { command: echo, args: [done] }
workflows:
  delivery:
    on: { source: queue }
    jobs:
      notify: { use: notify }
workspace: {}
execution: {}
logging: { level: silent }
`);

    const projects = new ProjectManager({ stateHome });
    const project = await projects.register(root);
    let testedAction: { workflowId: string; actionId: string } | undefined;
    const server = new GlobalDashboardServer(projects, {
      workflowActionTest: async (_context, workflowId, actionId) => {
        testedAction = { workflowId, actionId };
        return {
          workflowId,
          actionId,
          sourceId: "queue",
          triggerMatchCount: 2,
          eligibleCount: 1,
          items: [{ id: "ENG-1", title: "One", eligible: true, decision: "run", reason: "would start now", run: null }],
        };
      },
      workflowDraftTest: async (_context, workflowId) => ({
        workflowId,
        sourceId: "queue",
        triggerMatchCount: 1,
        eligibleCount: 1,
        items: [{
          id: "ENG-1",
          title: "One",
          eligible: true,
          decision: "run",
          reason: "one or more jobs would start now",
          jobs: [{ id: "notify", use: "notify", eligible: true, decision: "run", reason: "would start now" }],
          run: null,
        }],
      }),
    });
    const authenticated = new URL(await server.start(0));
    const request = async (path: string, init?: RequestInit) => fetch(new URL(`${path}${path.includes("?") ? "&" : "?"}token=${authenticated.searchParams.get("token")}`, authenticated), init);
    try {
      const listed = await request("/api/projects");
      expect(listed.status).toBe(200);
      expect((await listed.json() as any).projects[0]).toMatchObject({ id: project.id, root: project.root, displayName: "dashboard-test" });
      expect((await request("/api/projects/not-registered")).status).toBe(404);

      const workflowsResponse = await request(`/api/projects/${project.id}/workflows`);
      const workflow = (await workflowsResponse.json() as any).workflows[0];
      expect(workflow).toMatchObject({ id: "delivery", source: "queue", projectFolderId: project.id, repository: project.repository });

      const actionPreview = await request(`/api/projects/${project.id}/workflows/delivery/actions/notify/test`, { method: "POST" });
      expect(actionPreview.status).toBe(200);
      expect(await actionPreview.json()).toMatchObject({ ok: true, dryRun: true, result: { triggerMatchCount: 2, eligibleCount: 1 } });
      expect(testedAction).toEqual({ workflowId: "delivery", actionId: "notify" });

      const draftPreview = await request(`/api/projects/${project.id}/workflows/delivery/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: { enabled: true, on: { source: "queue", match: {}, fire: { policy: "once-per-match" } }, jobs: { notify: { use: "notify" } } } }),
      });
      expect(draftPreview.status).toBe(200);
      expect(await draftPreview.json()).toMatchObject({ ok: true, dryRun: true, draft: true, result: { workflowId: "delivery", eligibleCount: 1, items: [{ jobs: [{ id: "notify", eligible: true }] }] } });

      const save = await request(`/api/projects/${project.id}/workflows/delivery`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: workflow.revision, workflow: { enabled: true, on: { source: "queue", match: {}, fire: { policy: "once-per-match" } }, jobs: { notify: { use: "notify" } } } }),
      });
      expect(save.status).toBe(200);
      expect(await readFile(join(root, ".task-relay.yaml"), "utf8")).toContain("# preserved project comment");

      const conflict = await request(`/api/projects/${project.id}/workflows/delivery`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: workflow.revision, workflow: workflow }),
      });
      expect(conflict.status).toBe(409);

      // Whole-document writes would discard YAML comments/anchors, so this
      // compatibility endpoint must direct clients to workflow CRUD instead.
      expect((await request(`/api/projects/${project.id}/config/json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: {} }) })).status).toBe(501);
      expect((await request(`/api/projects/${project.id}/start`, { method: "GET" })).status).toBe(405);

      const layout = { nodes: { trigger: { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1 } };
      expect((await request(`/api/projects/${project.id}/workflows/delivery/layout`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(layout) })).status).toBe(200);
      const loadedLayout = await request(`/api/projects/${project.id}/workflows/delivery/layout`);
      expect((await loadedLayout.json() as any).layout).toEqual(layout);

      const catalog = await request(`/api/projects/${project.id}/catalog`);
      expect((await catalog.json() as any).schemas["action:launch"]).toBeTruthy();
    } finally {
      await server.stop();
      projects.close();
    }
  });
});
