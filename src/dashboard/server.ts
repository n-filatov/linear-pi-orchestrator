import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { parse } from "yaml";
import { ZodError } from "zod";
import { CONFIG_FILE, renderRelayConfig } from "../config/load.js";
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
      const cleanupMatch = /^\/api\/runs\/(.+)\/cleanup$/.exec(url.pathname);
      if (cleanupMatch && method === "POST") { await this.apiCleanup(decodeURIComponent(cleanupMatch[1]), res); return; }
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
