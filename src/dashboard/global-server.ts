import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as http from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginCatalog, type PluginCatalogEntry } from "../plugins/catalog.js";
import { listCodexModels, type CodexModel } from "../codex/index.js";
import { withUsesAlias, workflowSchema } from "../config/v2.js";
import type { RelayCommandHandlers } from "../cli/program.js";
import { graphToRelayWorkflow, relayWorkflowToGraph, type WorkflowGraph } from "../workflows/graph.js";
import { CanvasLayoutStore } from "./canvas-layout-store.js";
import { ProjectManager, ProjectNotFoundError } from "./project-manager.js";
import { GlobalRuntimeSupervisor } from "./runtime-supervisor.js";
import { closeCodexAppServers } from "../app.js";
import { WorkflowAlreadyExistsError, WorkflowConfigRepository, WorkflowNotFoundError, WorkflowRevisionConflictError } from "./workflow-config-repository.js";
import { listPromptFiles, PROMPTS_DIRECTORY } from "../prompts/library.js";
import { LinearMcpSource } from "../sources/linear-mcp-source.js";
import { SdkMcpToolClient, type McpTransportConfig } from "../sources/mcp-tool-client.js";
import { inspectWorkflowRun } from "../application/execution-inspection.js";
import type { WorkflowRunRecord } from "../domain/index.js";
import { ZodError } from "zod";

const MAX_BODY_BYTES = 1_000_000;
class RequestBodyTooLargeError extends Error {}

/** Global localhost-only control plane serving the React dashboard and JSON API. */
export class GlobalDashboardServer {
  private readonly server: http.Server;
  private readonly token = randomBytes(24).toString("base64url");
  private readonly supervisor: GlobalRuntimeSupervisor;
  private readonly staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/dashboard-client");
  private readonly codexModelCache = new Map<string, { expiresAt: number; models: CodexModel[] }>();
  private port = 0;

  constructor(
    readonly projects: ProjectManager,
    private readonly handlers: RelayCommandHandlers,
  ) {
    this.supervisor = new GlobalRuntimeSupervisor(projects, handlers);
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
  }

  start(port = 3001): Promise<string> {
    return new Promise((resolveStart, reject) => {
      this.server.listen(port, "127.0.0.1", () => {
        this.port = (this.server.address() as { port: number }).port;
        resolveStart(`http://127.0.0.1:${this.port}/?token=${encodeURIComponent(this.token)}`);
      });
      this.server.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    await this.supervisor.stopAll();
    await closeCodexAppServers();
    await new Promise<void>((resolveStop) => this.server.close(() => resolveStop()));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port || 3001}`);
    try {
      this.assertLocalRequest(request);
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        if (!this.authorized(request, url)) return this.json(response, { error: "Open the authenticated dashboard URL printed by Relay." }, 401);
        if (url.searchParams.get("token")) {
          response.setHeader("Set-Cookie", `relay_token=${this.token}; HttpOnly; SameSite=Strict; Path=/`);
          const preserved = new URLSearchParams(url.searchParams);
          preserved.delete("token");
          const suffix = preserved.toString();
          response.setHeader("Location", `${url.pathname || "/"}${suffix ? `?${suffix}` : ""}`);
          response.writeHead(302);
          response.end();
          return;
        }
        await this.staticAsset(url.pathname, response);
        return;
      }
      if (!this.authorized(request, url)) return this.json(response, { error: "Unauthorized" }, 401);
      await this.api(request, response, url);
    } catch (error) {
      const status = error instanceof WorkflowRevisionConflictError || error instanceof WorkflowAlreadyExistsError ? 409
        : error instanceof WorkflowNotFoundError || error instanceof ProjectNotFoundError ? 404
        : error instanceof SyntaxError || error instanceof URIError || error instanceof ZodError ? 400
        : error instanceof RequestBodyTooLargeError ? 413 : 500;
      this.json(response, {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof WorkflowRevisionConflictError ? { expectedRevision: error.expected, actualRevision: error.actual } : {}),
      }, status);
    }
  }

  private async api(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/projects") return this.json(response, { projects: await this.projects.listProjects() });
    if (method === "POST" && url.pathname === "/api/projects") {
      const body = await jsonBody(request);
      if (typeof body.root !== "string" || !body.root.trim()) return this.json(response, { error: "A repository folder path is required." }, 400);
      return this.json(response, { project: await this.projects.register(body.root, { displayName: stringValue(body.displayName), enabled: booleanValue(body.enabled) }) }, 201);
    }
    if (method === "GET" && url.pathname === "/api/workflows") {
      const workflows = (await Promise.all((await this.projects.listProjects()).map((project) => this.workflowList(project.id)))).flat();
      return this.json(response, { workflows });
    }
    if (method === "GET" && url.pathname === "/api/executions") return this.executionList(response, url.searchParams.get("folderId") ?? undefined, url.searchParams.get("status") ?? undefined);
    if (method === "GET" && url.pathname === "/api/runs") return this.json(response, { runs: this.projects.workflows.list().map(presentExecution) });
    if (method === "GET" && url.pathname === "/api/workers") return this.json(response, { workers: this.projects.workers.list({ includeCleaned: true }) });
    if (method === "GET" && url.pathname === "/api/events") return this.events(request, response);
    if (method === "GET" && url.pathname === "/api/supervisor") return this.json(response, { projects: this.supervisor.status() });

    const codexModels = /^\/api\/projects\/([^/]+)\/codex\/models$/.exec(url.pathname);
    if (codexModels) {
      if (method !== "GET") return this.methodNotAllowed(response);
      const folder = await this.requireProject(decodeURIComponent(codexModels[1]!));
      return this.json(response, { models: await this.modelsFor(folder.root) });
    }

    const linearOptions = /^\/api\/projects\/([^/]+)\/sources\/([^/]+)\/linear-options$/.exec(url.pathname);
    if (linearOptions) {
      if (method !== "GET") return this.methodNotAllowed(response);
      return this.linearTriggerOptions(decodeURIComponent(linearOptions[1]!), decodeURIComponent(linearOptions[2]!), response);
    }

    const project = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
    if (project) {
      const projectId = decodeURIComponent(project[1]!);
      if (method === "GET") return this.json(response, { project: await this.requireProject(projectId) });
      if (method === "PATCH" || method === "PUT") return this.json(response, { project: await this.projects.update(projectId, await jsonBody(request)) });
      if (method === "DELETE") {
        const folder = await this.requireProject(projectId);
        await this.supervisor.stop(projectId);
        await closeCodexAppServers(folder.root);
        await this.projects.remove(projectId);
        return this.json(response, { ok: true });
      }
      return this.methodNotAllowed(response);
    }

    const projectAction = /^\/api\/projects\/([^/]+)\/(sync|start|stop)$/.exec(url.pathname);
    if (projectAction && method === "POST") {
      const projectId = decodeURIComponent(projectAction[1]!);
      const action = projectAction[2];
      if (action === "sync") return this.json(response, { project: await this.projects.sync(projectId) });
      if (action === "start") return this.json(response, { status: await this.supervisor.start(projectId) });
      const folder = await this.requireProject(projectId);
      const status = await this.supervisor.stop(projectId);
      await closeCodexAppServers(folder.root);
      return this.json(response, { status });
    }
    if (projectAction) return this.methodNotAllowed(response);

    const projectCollection = /^\/api\/projects\/([^/]+)\/(workflows|executions|workers|catalog|plugins|prompts)$/.exec(url.pathname);
    if (projectCollection) {
      const projectId = decodeURIComponent(projectCollection[1]!);
      const resource = projectCollection[2];
      if (resource === "workflows" && method === "GET") return this.json(response, { workflows: await this.workflowList(projectId) });
      if (resource === "workflows" && method === "POST") return this.createWorkflow(projectId, request, response);
      if (resource === "executions" && method === "GET") return this.executionList(response, projectId);
      if (resource === "workers" && method === "GET") {
        const folder = await this.requireProject(projectId);
        return this.json(response, { workers: this.projects.workers.list({ repository: folder.repository, includeCleaned: true }) });
      }
      if (resource === "prompts" && method === "GET") {
        const folder = await this.requireProject(projectId);
        return this.json(response, { directory: PROMPTS_DIRECTORY, prompts: await listPromptFiles(folder.root) });
      }
      if ((resource === "catalog" || resource === "plugins") && method === "GET") {
        const context = await this.projects.context(projectId);
        const catalog = await buildPluginCatalog({ config: context.config, projectRoot: context.projectRoot });
        if (resource === "plugins") return this.json(response, {
          ...catalog,
          installed: catalog.entries.filter((entry) => entry.installed),
          referenced: catalog.entries.map((entry) => ({ use: entry.use, kind: entry.kind, state: entry.health, locations: [], error: entry.error })),
        });
        return this.json(response, presentCatalog(catalog.entries));
      }
      return this.methodNotAllowed(response);
    }

    const config = /^\/api\/projects\/([^/]+)\/config\/(json|mtime)$/.exec(url.pathname);
    if (config) return this.projectConfig(decodeURIComponent(config[1]!), config[2]!, method, request, response);

    const workflow = /^\/api\/projects\/([^/]+)\/workflows\/([^/]+)$/.exec(url.pathname);
    if (workflow) return this.workflowResource(decodeURIComponent(workflow[1]!), decodeURIComponent(workflow[2]!), method, request, response);

    const workflowActionTest = /^\/api\/projects\/([^/]+)\/workflows\/([^/]+)\/actions\/([^/]+)\/test$/.exec(url.pathname);
    if (workflowActionTest) return this.workflowActionTest(
      decodeURIComponent(workflowActionTest[1]!),
      decodeURIComponent(workflowActionTest[2]!),
      decodeURIComponent(workflowActionTest[3]!),
      method,
      request,
      response,
    );

    const workflowAction = /^\/api\/projects\/([^/]+)\/workflows\/([^/]+)\/(test|layout)$/.exec(url.pathname);
    if (workflowAction) return this.workflowAction(decodeURIComponent(workflowAction[1]!), decodeURIComponent(workflowAction[2]!), workflowAction[3]!, method, request, response);

    const execution = /^\/api\/executions\/([^/]+)$/.exec(url.pathname);
    if (execution) {
      if (method !== "GET") return this.methodNotAllowed(response);
      const id = decodeURIComponent(execution[1]!);
      const run = this.projects.workflows.get(id);
      if (!run) return this.json(response, { error: "Execution not found" }, 404);
      const canonical = run.snapshot as WorkflowRunRecord;
      const rawInspection = canonical && typeof canonical === "object" && canonical.jobs && canonical.item
        ? inspectWorkflowRun(canonical)
        : presentExecution(run);
      const definitionMetadata = canonical.definition?.metadata;
      const definitionRevision = definitionMetadata?.revision ?? (canonical.definition ? definitionFingerprint(canonical.definition) : undefined);
      const pluginRevisions = recordOfStrings(definitionMetadata?.pluginRevisions);
      const inspection = rawInspection && typeof rawInspection === "object"
        ? { ...rawInspection as Record<string, unknown>, definitionRevision, pluginRevisions }
        : rawInspection;
      return this.json(response, {
        execution: presentExecution(run),
        inspection,
        jobs: this.projects.workflows.listJobs(id),
        events: this.projects.workflows.listEvents(id),
        retryEligibility: retryEligibility(canonical.jobs ?? {}, undefined, new Date().toISOString()),
      });
    }
    const retry = /^\/api\/executions\/([^/]+)\/retry$/.exec(url.pathname);
    if (retry) return method === "POST" ? this.retryExecution(decodeURIComponent(retry[1]!), request, response) : this.methodNotAllowed(response);

    const workerAction = /^\/api\/(?:projects\/([^/]+)\/)?workers\/([^/]+)\/(send|exec)$/.exec(url.pathname);
    if (workerAction) return method === "POST"
      ? this.workerAction(workerAction[1] ? decodeURIComponent(workerAction[1]) : undefined, decodeURIComponent(workerAction[2]!), workerAction[3] as "send" | "exec", request, response)
      : this.methodNotAllowed(response);

    this.json(response, { error: "Not found" }, 404);
  }

  private async workflowList(projectId: string): Promise<Record<string, unknown>[]> {
    const project = await this.requireProject(projectId);
    const repository = new WorkflowConfigRepository(project.root);
    const runs = this.projects.workflows.list({ projectFolderId: projectId });
    return (await repository.list()).map((entry) => ({
      id: entry.workflowId,
      projectFolderId: project.id,
      repository: project.repository,
      ...entry.workflow,
      source: entry.workflow.on.source,
      fire: entry.workflow.on.fire.policy,
      revision: entry.revision,
      graph: relayWorkflowToGraph(entry.workflowId, entry.workflow),
      runs: runs.filter((run) => run.identity.workflowId === entry.workflowId).map(presentExecution),
    }));
  }

  private async modelsFor(projectRoot: string): Promise<CodexModel[]> {
    const cached = this.codexModelCache.get(projectRoot);
    if (cached && cached.expiresAt > Date.now()) return cached.models;
    const models = await listCodexModels(projectRoot);
    this.codexModelCache.set(projectRoot, { expiresAt: Date.now() + 5 * 60_000, models });
    return models;
  }

  private async linearTriggerOptions(projectId: string, sourceId: string, response: http.ServerResponse): Promise<void> {
    const context = await this.projects.context(projectId);
    const source = context.config.sources[sourceId];
    if (!source || source.use !== "linear") return this.json(response, { error: `Source '${sourceId}' is not a configured Linear source.` }, 400);
    const options = recordValue(source.with);
    const mcp = recordValue(options.mcp);
    const client = await SdkMcpToolClient.connect({ clientName: "task-relay-dashboard", clientVersion: "0.2.0", transport: dashboardMcpTransport(mcp, context.projectRoot) });
    try {
      const linear = new LinearMcpSource({ id: sourceId, client, tools: recordValue(options.tools) });
      this.json(response, { sourceId, ...(await linear.triggerOptions()) });
    } finally {
      await client.close();
    }
  }

  private async createWorkflow(projectId: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const body = await jsonBody(request);
    const id = stringValue(body.id) ?? stringValue(body.workflowId);
    if (!id) return this.json(response, { error: "A workflow id is required." }, 400);
    const project = await this.requireProject(projectId);
    const workflow = workflowValue(body.workflow ?? body.graph, id);
    const saved = await new WorkflowConfigRepository(project.root).create(id, workflow, stringValue(body.expectedRevision));
    await this.projects.sync(projectId);
    this.json(response, { workflow: { id, ...saved.workflow, revision: saved.revision, graph: relayWorkflowToGraph(id, saved.workflow) } }, 201);
  }

  private async workflowResource(projectId: string, workflowId: string, method: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const project = await this.requireProject(projectId);
    const repository = new WorkflowConfigRepository(project.root);
    if (method === "GET") {
      const entry = await repository.get(workflowId);
      return this.json(response, { workflow: { id: workflowId, ...entry.workflow, revision: entry.revision, graph: relayWorkflowToGraph(workflowId, entry.workflow) } });
    }
    if (method === "PUT") {
      const body = await jsonBody(request);
      const value = workflowValue(body.workflow ?? body.graph ?? body, workflowId);
      const saved = await repository.save(workflowId, value, stringValue(body.expectedRevision));
      await this.projects.sync(projectId);
      return this.json(response, { workflow: { id: workflowId, ...saved.workflow, revision: saved.revision, graph: relayWorkflowToGraph(workflowId, saved.workflow) } });
    }
    if (method === "PATCH") {
      const body = await jsonBody(request);
      const nextWorkflowId = stringValue(body.nextWorkflowId);
      if (!nextWorkflowId) return this.json(response, { error: "A new workflow id is required." }, 400);
      const saved = await repository.rename(workflowId, nextWorkflowId, stringValue(body.expectedRevision));
      const layouts = new CanvasLayoutStore(project.root);
      const layout = await layouts.get(workflowId);
      if (layout) { await layouts.set(nextWorkflowId, layout); await layouts.remove(workflowId); }
      await this.projects.sync(projectId);
      return this.json(response, { workflow: { id: nextWorkflowId, ...saved.workflow, revision: saved.revision } });
    }
    if (method === "DELETE") {
      const body = await optionalJsonBody(request);
      const result = await repository.remove(workflowId, stringValue(body.expectedRevision));
      await new CanvasLayoutStore(project.root).remove(workflowId);
      await this.projects.sync(projectId);
      return this.json(response, { ok: true, revision: result.revision });
    }
    this.json(response, { error: "Method not allowed" }, 405);
  }

  private async workflowAction(projectId: string, workflowId: string, action: string, method: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const project = await this.requireProject(projectId);
    if (action === "layout") {
      const layouts = new CanvasLayoutStore(project.root);
      // Layout is repository-owned too: do not create orphan UI state for a
      // typo or a workflow that was deleted in another editor.
      await new WorkflowConfigRepository(project.root).get(workflowId);
      if (method === "GET") {
        const layout = await layouts.get(workflowId) ?? { nodes: {} };
        const nodes = Object.entries(layout.nodes).map(([id, position]) => ({ id, ...position }));
        return this.json(response, { layout, nodes, viewport: layout.viewport });
      }
      if (method === "PUT") {
        const body = await jsonBody(request);
        const input = (body.layout ?? body) as Record<string, any>;
        const nodes = Array.isArray(input.nodes)
          ? Object.fromEntries(input.nodes.map((node: Record<string, unknown>) => [String(node.id), { x: Number(node.x), y: Number(node.y) }]))
          : input.nodes;
        await layouts.set(workflowId, { ...input, nodes } as never);
        return this.json(response, { ok: true });
      }
    }
    if (action === "test" && method === "POST") {
      const context = await this.projects.context(projectId);
      const body = await optionalJsonBody(request);
      if (body.workflow !== undefined) {
        if (!this.handlers.workflowDraftTest) return this.json(response, { error: "Draft workflow preview is not available." }, 501);
        const draft = workflowValue(body.workflow, workflowId);
        const result = await this.handlers.workflowDraftTest(context, workflowId, { workflow: draft });
        return this.json(response, { ok: true, dryRun: true, draft: true, result });
      }
      if (!this.handlers.workflowTest) return this.json(response, { error: "Workflow test is not available." }, 501);
      const output: string[] = [];
      await this.handlers.workflowTest({ ...context, write: (line) => output.push(line) }, workflowId);
      return this.json(response, { ok: true, output: output.join("\n") });
    }
    this.json(response, { error: "Method not allowed" }, 405);
  }

  /**
   * Previewing an action is intentionally separate from a workflow test: it
   * returns structured rows the canvas can count and render without parsing
   * CLI text. The handler only discovers source items and reads persisted run
   * state; it never claims a ticket, creates a workspace, or starts a worker.
   */
  private async workflowActionTest(projectId: string, workflowId: string, actionId: string, method: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (method !== "POST") return this.methodNotAllowed(response);
    if (!this.handlers.workflowActionTest) return this.json(response, { error: "Workflow action test is not available." }, 501);
    const body = await optionalJsonBody(request);
    // Validate the draft with the same v2 schema as workflow saves. It is
    // passed to the handler in memory only; this endpoint never writes YAML.
    const draft = body.workflow === undefined ? undefined : workflowValue(body.workflow, workflowId);
    const context = await this.projects.context(projectId);
    const result = await this.handlers.workflowActionTest(context, workflowId, actionId, draft ? { workflow: draft } : undefined);
    this.json(response, { ok: true, dryRun: true, result });
  }

  private executionList(response: http.ServerResponse, projectId?: string, status?: string): void {
    const executions = this.projects.workflows.list({
      ...(projectId ? { projectFolderId: projectId } : {}),
      ...(status ? { statuses: status.split(",") as Array<"running" | "succeeded" | "failed"> } : {}),
    }).map(presentExecution);
    this.json(response, { executions });
  }

  private async retryExecution(id: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const indexed = this.projects.workflows.get(id);
    if (!indexed) return this.json(response, { error: "Execution not found" }, 404);
    const body = await optionalJsonBody(request);
    const context = await this.projects.context(indexed.projectFolderId);
    const repositoryRun = (await context.store.snapshot()).workflows[id];
    if (!repositoryRun) return this.json(response, { error: "Repository execution record was not found." }, 404);
    const jobIds = body.jobIds === undefined ? undefined : Array.isArray(body.jobIds)
      ? [...new Set(body.jobIds.filter((value): value is string => typeof value === "string" && value.length > 0))]
      : undefined;
    if (body.jobIds !== undefined && (!jobIds?.length || !Array.isArray(body.jobIds) || jobIds.some((jobId) => !repositoryRun.jobs[jobId]))) {
      return this.json(response, { error: "Retry jobIds must name one or more jobs in this execution." }, 400);
    }
    const eligibility = retryEligibility(repositoryRun.jobs, jobIds, new Date().toISOString());
    // A run-level retry is intentionally narrowed to its failed jobs and may
    // coexist with completed upstream jobs. An explicit selection is stricter:
    // never silently drop a completed job the user asked to replay.
    if (eligibility.eligible.length === 0 || (jobIds !== undefined && eligibility.ineligible.length > 0)) {
      return this.json(response, {
        error: eligibility.eligible.length === 0 ? "No jobs in this execution are eligible for retry." : "One or more selected jobs are not eligible for retry.",
        retryEligibility: eligibility,
      }, 409);
    }
    const run = await context.store.retryWorkflowJobs(repositoryRun.identity, eligibility.eligible, new Date().toISOString());
    if (!run) return this.json(response, { error: "Repository execution record was not found." }, 404);
    const project = await this.requireProject(indexed.projectFolderId);
    this.projects.workflows.syncRun(run, { repository: project.repository });
    this.projects.workflows.appendEvent(run.id, "workflow.retried", run.updatedAt, { jobIds: eligibility.eligible });
    if (this.handlers.once) await this.handlers.once(context, { trigger: run.identity.workflowId, task: run.identity.itemId });
    this.json(response, { execution: presentExecution(this.projects.workflows.get(id) ?? indexed), retryEligibility: eligibility });
  }

  private async workerAction(projectId: string | undefined, workerId: string, action: "send" | "exec", request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.handlers.workerControl) return this.json(response, { error: "Worker control is not available." }, 501);
    const worker = this.projects.workers.get(workerId);
    if (!worker) return this.json(response, { error: "Worker not found" }, 404);
    const folder = projectId ? await this.requireProject(projectId) : this.projects.workflows.findProjectFolder(worker.repository);
    if (!folder) return this.json(response, { error: "Worker repository is not registered." }, 409);
    if (folder.repository.id !== worker.repository.id || folder.repository.root !== worker.repository.root) {
      return this.json(response, { error: "Worker does not belong to the selected project folder." }, 409);
    }
    const context = await this.projects.context(folder.id);
    const body = await jsonBody(request);
    const command = action === "send"
      ? { type: "send" as const, text: String(body.text ?? ""), submit: body.submit !== false }
      : { type: "exec" as const, command: String(body.command ?? ""), args: Array.isArray(body.args) ? body.args.map(String) : [], open: body.open === "window" ? "window" as const : "pane" as const, ...(body.name ? { name: String(body.name) } : {}) };
    if ((action === "send" && !String(body.text ?? "").trim()) || (action === "exec" && !String(body.command ?? "").trim())) {
      return this.json(response, { error: `${action === "send" ? "text" : "command"} is required.` }, 400);
    }
    this.json(response, { ok: true, message: await this.handlers.workerControl(context, workerId, command) });
  }

  private async projectConfig(projectId: string, kind: string, method: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const project = await this.requireProject(projectId);
    const context = await this.projects.context(projectId);
    const repository = new WorkflowConfigRepository(project.root);
    if (kind === "mtime" && method === "GET") return this.json(response, { mtime: (await stat(repository.configPath)).mtimeMs });
    if (kind === "json" && method === "GET") return this.json(response, { config: context.config });
    if (kind === "json" && method === "PUT") {
      // Re-rendering a whole normalized config destroys comments and anchors.
      // The revision-checked workflow endpoints are the safe editing surface.
      return this.json(response, { error: "Whole-config writes are not supported by the global dashboard. Save workflows through their revision-checked endpoints." }, 501);
    }
    this.json(response, { error: "Method not allowed" }, 405);
  }

  private events(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
    let last = "";
    const push = () => {
      const snapshot = JSON.stringify({ executions: this.projects.workflows.list().map(presentExecution), workers: this.projects.workers.list({ includeCleaned: true }), supervisor: this.supervisor.status() });
      if (snapshot !== last) { last = snapshot; response.write(`event: snapshot\ndata: ${snapshot}\n\n`); }
    };
    push();
    const poll = setInterval(push, 1_000);
    const beat = setInterval(() => response.write(": ping\n\n"), 25_000);
    const close = () => { clearInterval(poll); clearInterval(beat); response.end(); };
    request.once("close", close);
    request.once("error", close);
  }

  private async requireProject(projectId: string) {
    const project = await this.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    return project;
  }

  private async staticAsset(pathname: string, response: http.ServerResponse): Promise<void> {
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const candidate = resolve(this.staticRoot, relative);
    if (!candidate.startsWith(`${this.staticRoot}/`) && candidate !== resolve(this.staticRoot, "index.html")) return this.json(response, { error: "Not found" }, 404);
    const file = existsSync(candidate)
      ? candidate
      : pathLooksLikeAsset(relative)
        ? undefined
        : resolve(this.staticRoot, "index.html");
    if (!file) return this.json(response, { error: "Not found" }, 404);
    if (!existsSync(file)) return this.json(response, { error: "Dashboard assets are missing. Run 'npm run build:dashboard'." }, 503);
    response.writeHead(200, { "Content-Type": mimeType(file), "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    response.end(await readFile(file));
  }

  private assertLocalRequest(request: http.IncomingMessage): void {
    const host = request.headers.host?.split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") throw new Error("The dashboard only accepts localhost requests.");
    if (request.headers.origin) {
      const origin = new URL(request.headers.origin).hostname;
      if (origin !== "127.0.0.1" && origin !== "localhost" && origin !== "[::1]") throw new Error("Cross-origin requests are not allowed.");
    }
  }

  private authorized(request: http.IncomingMessage, url: URL): boolean {
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("relay_token="))?.slice("relay_token=".length);
    const candidate = url.searchParams.get("token") ?? request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? cookie;
    if (!candidate) return false;
    const left = Buffer.from(candidate);
    const right = Buffer.from(this.token);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private json(response: http.ServerResponse, data: unknown, status = 200): void {
    if (response.headersSent) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify(data));
  }

  private methodNotAllowed(response: http.ServerResponse): void {
    response.setHeader("Allow", "GET, POST, PUT, PATCH, DELETE");
    this.json(response, { error: "Method not allowed" }, 405);
  }
}

function workflowValue(value: unknown, workflowId: string) {
  if (!isRecord(value)) return workflowSchema.parse(value);
  const workflow = Array.isArray(value.nodes) && Array.isArray(value.edges)
    ? graphToRelayWorkflow({ id: workflowId, ...value } as unknown as WorkflowGraph)
    : (() => {
      const { id: _id, source: _source, fire: _fire, revision: _revision, graph: _graph, runs: _runs, projectFolderId: _projectFolderId, repository: _repository, ...raw } = value;
      return raw;
    })();
  return workflowSchema.parse(withUsesAlias(workflow));
}

function presentExecution(run: ReturnType<ProjectManager["workflows"]["get"]> extends infer T ? NonNullable<T> : never): Record<string, unknown> {
  return { ...run.snapshot, id: run.id, projectFolderId: run.projectFolderId, workflowId: run.identity.workflowId, status: run.status };
}

/**
 * The durable store's low-level retry operation can clear any terminal state
 * for CLI compatibility. The dashboard exposes a narrower recovery contract:
 * only failed jobs (plus the historical timed_out marker) may be replayed.
 * Uncertain attempts are deliberately held for inspection instead.
 */
export function retryEligibility(
  jobs: Record<string, { status?: string; needsAttention?: boolean; retryAt?: string }>,
  requested?: readonly string[],
  now = new Date().toISOString(),
): { eligible: string[]; ineligible: Array<{ id: string; status?: string; reason: string }> } {
  const ids = requested ? [...requested] : Object.keys(jobs);
  const eligible: string[] = [];
  const ineligible: Array<{ id: string; status?: string; reason: string }> = [];
  for (const id of ids) {
    const state = jobs[id];
    if (!state) {
      ineligible.push({ id, reason: "job is not recorded in this execution" });
      continue;
    }
    if (state.needsAttention) {
      ineligible.push({ id, status: state.status, reason: "attempt requires manual inspection before retry" });
      continue;
    }
    if (state.retryAt) {
      const retryAt = Date.parse(state.retryAt);
      if (!Number.isFinite(retryAt)) {
        ineligible.push({ id, status: state.status, reason: "job has an invalid scheduled retry time" });
        continue;
      }
      if (retryAt > Date.parse(now)) {
        ineligible.push({ id, status: state.status, reason: `job is scheduled for retry at ${state.retryAt}` });
        continue;
      }
    }
    if (state.status === "failed" || state.status === "timed_out") eligible.push(id);
    else ineligible.push({ id, status: state.status, reason: "only failed or timed_out jobs can be retried" });
  }
  return { eligible, ineligible };
}

/** Stable display fingerprint for legacy definitions that did not persist a revision. */
function definitionFingerprint(definition: unknown): string {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, normalize(entry)]))
    : value;
  return createHash("sha256").update(JSON.stringify(normalize(definition))).digest("hex").slice(0, 12);
}

function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function presentCatalog(entries: readonly PluginCatalogEntry[]): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const entry of entries) {
    const value = { use: entry.use, kind: entry.kind, schema: entry.kind === "source" ? entry.matchSchema ?? entry.configSchema : entry.configSchema, presentation: entry.presentation, health: entry.health };
    schemas[`${entry.kind}:${entry.use}`] = value;
    // Existing clients address actions by their short `use` name. Prefer the
    // action when a source and action intentionally share a name like command.
    if (!(entry.use in schemas) || entry.kind === "action") schemas[entry.use] = value;
  }
  return {
    entries,
    schemas,
  };
}

async function jsonBody(request: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestBodyTooLargeError("Request body is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, any> : {};
}

async function optionalJsonBody(request: http.IncomingMessage): Promise<Record<string, any>> {
  return jsonBody(request);
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function recordValue(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function booleanValue(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function stringRecord(value: unknown): Record<string, string> { return Object.fromEntries(Object.entries(recordValue(value)).flatMap(([key, entry]) => typeof entry === "string" ? [[key, entry]] : [])); }
function dashboardMcpTransport(value: Record<string, unknown>, projectRoot: string): McpTransportConfig {
  if (value.transport === "stdio") {
    const command = stringValue(value.command);
    if (!command) throw new Error("Linear stdio MCP transport requires a command.");
    return { transport: "stdio", command, args: stringArray(value.args), cwd: stringValue(value.cwd) ? resolve(projectRoot, stringValue(value.cwd)!) : projectRoot, env: stringRecord(value.environment ?? value.env) };
  }
  if (value.transport === "streamable-http") {
    const url = stringValue(value.url);
    if (!url) throw new Error("Linear HTTP MCP transport requires a URL.");
    const headers: Record<string, string> = {};
    for (const [header, environmentName] of Object.entries(stringRecord(value.headersFromEnvironment))) {
      const resolved = process.env[environmentName];
      if (!resolved) throw new Error(`Environment variable ${environmentName} is required for MCP header ${header}.`);
      headers[header] = resolved;
    }
    return { transport: "streamable-http", url, headers };
  }
  throw new Error("Linear MCP transport must be 'stdio' or 'streamable-http'.");
}
function mimeType(file: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
}

function pathLooksLikeAsset(pathname: string): boolean {
  return pathname.startsWith("assets/");
}
