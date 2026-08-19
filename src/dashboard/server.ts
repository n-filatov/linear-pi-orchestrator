import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { parse } from "yaml";
import { ZodError } from "zod";
import { CONFIG_FILE, renderRelayConfig } from "../config/load.js";
import { eventLogPath } from "../logging/events.js";
import { normalizeRelayConfig } from "../config/v2.js";
import { RepositoryDaemon } from "../daemon.js";
import type { RelayCommandContext, RelayCommandHandlers } from "../cli/program.js";
import { renderDashboardHtml } from "./ui.js";

export class DashboardServer {
  private readonly server: http.Server;
  private readonly configPath: string;
  private port = 0;

  constructor(
    private readonly context: RelayCommandContext,
    private readonly handlers: RelayCommandHandlers,
  ) {
    this.configPath = path.resolve(context.projectRoot, CONFIG_FILE);
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
  }

  start(port = 3001): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.listen(port, "127.0.0.1", () => {
        this.port = (this.server.address() as { port: number }).port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
      this.server.once("error", reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { method } = req;
    try {
      if (method === "GET" && (url.pathname === "/" || url.pathname === "")) {
        const projectName = this.context.config.project.name || path.basename(this.context.projectRoot);
        this.sendHtml(res, renderDashboardHtml(projectName));
        return;
      }
      if (method === "GET" && url.pathname === "/api/status") { await this.apiStatus(res); return; }
      if (method === "GET" && url.pathname === "/api/runs") { await this.apiRuns(res); return; }
      if (method === "GET" && url.pathname === "/api/config") { await this.apiGetConfigYaml(res); return; }
      if (method === "PUT" && url.pathname === "/api/config") { await this.apiPutConfigYaml(req, res); return; }
      if (method === "GET" && url.pathname === "/api/config/json") { await this.apiGetConfigJson(res); return; }
      if (method === "PUT" && url.pathname === "/api/config/json") { await this.apiPutConfigJson(req, res); return; }
      if (method === "GET" && url.pathname === "/api/config/mtime") { this.apiConfigMtime(res); return; }
      if (method === "GET" && url.pathname === "/api/config/schema") { await this.apiSchema(res); return; }
      if (method === "GET" && url.pathname === "/api/plugins/schemas") { await this.apiPluginSchemas(res); return; }
      if (method === "GET" && url.pathname === "/api/workflows") { await this.apiWorkflows(res); return; }
      if (method === "GET" && url.pathname === "/api/plugins") { await this.apiPlugins(res); return; }
      if (method === "GET" && url.pathname === "/api/events") { this.apiEvents(req, res); return; }
      const cleanupMatch = /^\/api\/runs\/(.+)\/cleanup$/.exec(url.pathname);
      if (cleanupMatch && method === "POST") { await this.apiCleanup(decodeURIComponent(cleanupMatch[1]), res); return; }
      const workflowTest = /^\/api\/workflows\/(.+)\/test$/.exec(url.pathname);
      if (workflowTest && method === "POST") { await this.apiWorkflowTest(decodeURIComponent(workflowTest[1]), res); return; }
      const workerControl = /^\/api\/workers\/(.+)\/(send|exec)$/.exec(url.pathname);
      if (workerControl && method === "POST") { await this.apiWorkerControl(decodeURIComponent(workerControl[1]), workerControl[2] as "send" | "exec", req, res); return; }
      this.json(res, { error: "Not found" }, 404);
    } catch (error) {
      this.json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private json(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  private sendHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  }

  private async apiStatus(res: http.ServerResponse): Promise<void> {
    const runs = await this.context.store.listRuns();
    const daemon = new RepositoryDaemon(this.context.projectRoot);
    const daemonText = await daemon.status();
    this.json(res, {
      project: this.context.config.project.name || path.basename(this.context.projectRoot),
      daemon: daemonText.includes("is running") ? "running" : "stopped",
      daemonText,
      activeRuns: runs.filter((r) => ["claimed", "provisioning", "launching", "running"].includes(r.status)).length,
      totalRuns: runs.length,
      triggers: this.context.config.triggers.length,
      sources: Object.keys(this.context.config.sources).length,
    });
  }

  private async apiRuns(res: http.ServerResponse): Promise<void> {
    const runs = await this.context.store.listRuns();
    this.json(res, runs);
  }

  private async apiGetConfigYaml(res: http.ServerResponse): Promise<void> {
    const yaml = fs.readFileSync(this.configPath, "utf8");
    this.json(res, { yaml, path: this.configPath });
  }

  private async apiPutConfigYaml(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { yaml?: string };
    try { parsed = JSON.parse(body) as { yaml?: string }; }
    catch { this.json(res, { ok: false, errors: ["Invalid request body"] }, 400); return; }

    const yaml = parsed.yaml ?? "";
    const errors = validateYaml(yaml);
    if (errors) { this.json(res, { ok: false, errors }, 422); return; }

    await writeFileAtomic(this.configPath, yaml);
    this.json(res, { ok: true });
  }

  private async apiGetConfigJson(res: http.ServerResponse): Promise<void> {
    const yaml = fs.readFileSync(this.configPath, "utf8");
    try {
      const config = normalizeRelayConfig(parse(yaml) as unknown);
      this.json(res, { config, path: this.configPath });
    } catch (error) {
      this.json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async apiPutConfigJson(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { config?: unknown };
    try { parsed = JSON.parse(body) as { config?: unknown }; }
    catch { this.json(res, { ok: false, errors: ["Invalid request body"] }, 400); return; }

    let normalized;
    try {
      normalized = normalizeRelayConfig(parsed.config);
    } catch (error) {
      const errors = error instanceof ZodError
        ? error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
        : [error instanceof Error ? error.message : String(error)];
      this.json(res, { ok: false, errors }, 422);
      return;
    }

    const yaml = renderRelayConfig(normalized);
    await writeFileAtomic(this.configPath, yaml);
    this.json(res, { ok: true });
  }

  private apiConfigMtime(res: http.ServerResponse): void {
    try {
      const stat = fs.statSync(this.configPath);
      this.json(res, { mtime: stat.mtimeMs });
    } catch {
      this.json(res, { mtime: 0 });
    }
  }

  private async apiSchema(res: http.ServerResponse): Promise<void> {
    const { relayJsonSchema } = await import("../config/json-schema.js");
    this.json(res, relayJsonSchema());
  }

  private async apiPluginSchemas(res: http.ServerResponse): Promise<void> {
    const { pluginConfigSchemas } = await import("../config/json-schema.js");
    this.json(res, await pluginConfigSchemas(this.context.config, this.context.projectRoot));
  }

  /**
   * Every workflow with its declared jobs, joined to the persisted runs for
   * each item. The UI needs both halves to answer the only question that
   * matters while a workflow is live: what is each job doing, and what is it
   * waiting for.
   */
  private async apiWorkflows(res: http.ServerResponse): Promise<void> {
    const repository = { id: this.projectName(), root: this.context.projectRoot };
    const runs = await this.context.store.listWorkflowRuns(repository);
    const workflows = Object.entries(this.context.config.workflows).map(([id, workflow]) => ({
      id,
      enabled: workflow.enabled,
      source: workflow.on.source,
      fire: workflow.on.fire.policy,
      timeoutMinutes: workflow.timeoutMinutes,
      jobs: Object.entries(workflow.jobs).map(([jobId, job]) => ({
        id: jobId,
        use: job.use,
        needs: job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs],
        if: job.if ?? null,
        continueOnError: job.continueOnError,
        enabled: job.enabled,
      })),
      runs: runs.filter((run) => run.identity.workflowId === id),
    }));
    this.json(res, { workflows });
  }

  private async apiWorkflowTest(id: string, res: http.ServerResponse): Promise<void> {
    if (!this.handlers.workflowTest) { this.json(res, { error: "Workflow test not available" }, 501); return; }
    const lines: string[] = [];
    try {
      await this.handlers.workflowTest({ ...this.context, write: (value: string) => lines.push(value) }, id);
      this.json(res, { ok: true, output: lines.join("\n") });
    } catch (error) {
      this.json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  private async apiPlugins(res: http.ServerResponse): Promise<void> {
    const { BUILT_IN_ACTIONS, BUILT_IN_HARNESSES, BUILT_IN_SOURCES } = await import("../plugins/built-ins.js");
    const { checkPlugin, pluginDirectory, readPluginLock } = await import("../plugins/store.js");
    const lock = await readPluginLock();
    const config = this.context.config;

    const referenced = new Map<string, string[]>();
    const record = (use: string, where: string) => referenced.set(use, [...(referenced.get(use) ?? []), where]);
    for (const [id, source] of Object.entries(config.sources)) if (!BUILT_IN_SOURCES.has(source.use)) record(source.use, `sources.${id}`);
    for (const [id, action] of Object.entries(config.actions)) if (!BUILT_IN_ACTIONS.has(action.use)) record(action.use, `actions.${id}`);
    for (const [id, harness] of Object.entries(config.harnesses)) if (!BUILT_IN_HARNESSES.has(harness.use)) record(harness.use, `harnesses.${id}`);
    for (const trigger of config.triggers) {
      for (const [index, action] of trigger.actions.entries()) {
        if (typeof action !== "string" && !BUILT_IN_ACTIONS.has(action.use)) record(action.use, `triggers.${trigger.id}.actions.${index}`);
      }
    }
    for (const [name, workflow] of Object.entries(config.workflows)) {
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        if (!BUILT_IN_ACTIONS.has(job.use) && !config.actions[job.use]) record(job.use, `workflows.${name}.jobs.${jobId}`);
      }
    }

    const health = await Promise.all([...referenced].map(async ([use, locations]) => ({
      use,
      locations,
      ...(use.startsWith(".") || use.startsWith("/")
        ? { state: "local" as const }
        : await checkPlugin(use, lock).then((result) => result.state === "ok"
          ? { state: result.state, version: result.plugin.version }
          : { state: result.state })),
    })));

    this.json(res, { directory: pluginDirectory(), installed: Object.values(lock.plugins), referenced: health });
  }

  /**
   * A Server-Sent Events tail of the structured event log. The dashboard used
   * to poll and replace whole tables; a stream means a launched worker or a
   * finished job shows up when it happens.
   */
  private apiEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    const logPath = eventLogPath(this.context.projectRoot);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");

    let offset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    const push = () => {
      if (!fs.existsSync(logPath)) return;
      const size = fs.statSync(logPath).size;
      // A truncated or rotated log restarts from its new beginning.
      if (size < offset) offset = 0;
      if (size === offset) return;
      const handle = fs.openSync(logPath, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(handle, buffer, 0, buffer.length, offset);
        offset = size;
        for (const line of buffer.toString("utf8").split("\n")) {
          if (line.trim()) res.write(`data: ${line}\n\n`);
        }
      } finally { fs.closeSync(handle); }
    };

    const poll = setInterval(push, 1000);
    const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
    const close = () => { clearInterval(poll); clearInterval(beat); res.end(); };
    req.on("close", close);
    req.on("error", close);
  }

  private async apiWorkerControl(target: string, kind: "send" | "exec", req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.handlers.workerControl) { this.json(res, { error: "Worker control not available" }, 501); return; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; }
    catch { this.json(res, { ok: false, error: "Invalid request body" }, 400); return; }
    try {
      const action = kind === "send"
        ? { type: "send" as const, text: String(body.text ?? ""), submit: body.submit !== false }
        : {
          type: "exec" as const,
          command: String(body.command ?? ""),
          args: Array.isArray(body.args) ? body.args.map(String) : [],
          open: body.open === "window" ? "window" as const : "pane" as const,
          ...(body.name ? { name: String(body.name) } : {}),
        };
      if (action.type === "send" && !action.text.trim()) throw new Error("Nothing to send.");
      if (action.type === "exec" && !action.command.trim()) throw new Error("A command is required.");
      const message = await this.handlers.workerControl(this.context, target, action);
      this.json(res, { ok: true, message });
    } catch (error) {
      this.json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  private projectName(): string {
    return this.context.config.project.name || path.basename(this.context.projectRoot);
  }

  private async apiCleanup(runId: string, res: http.ServerResponse): Promise<void> {
    if (!this.handlers.cleanup) { this.json(res, { error: "Cleanup not available" }, 501); return; }
    const messages: string[] = [];
    const context = { ...this.context, write: (v: string) => messages.push(v) };
    try {
      await this.handlers.cleanup(context, runId);
      this.json(res, { ok: true, message: messages.join("\n") });
    } catch (error) {
      this.json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
}

function validateYaml(yaml: string): string[] | null {
  try {
    const raw = parse(yaml) as unknown;
    normalizeRelayConfig(raw);
    return null;
  } catch (error) {
    return error instanceof ZodError
      ? error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
      : [error instanceof Error ? error.message : String(error)];
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
