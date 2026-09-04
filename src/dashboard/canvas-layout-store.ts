import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";

export interface CanvasNodeLayout {
  x: number;
  y: number;
}

export interface CanvasWorkflowLayout {
  nodes: Record<string, CanvasNodeLayout>;
  viewport?: { x: number; y: number; zoom: number };
  groups?: Array<{ id: string; title: string; description?: string; nodeIds: string[] }>;
  notes?: Array<{ id: string; text: string; x: number; y: number; width?: number; height?: number }>;
}

type CanvasLayoutDocument = {
  version: 1;
  workflows: Record<string, CanvasWorkflowLayout>;
};

/** Repository-owned visual state. It never participates in execution. */
export class CanvasLayoutStore {
  readonly file: string;

  constructor(projectRoot: string) {
    this.file = resolve(projectRoot, ".task-relay.ui.json");
  }

  async get(workflowId: string): Promise<CanvasWorkflowLayout | undefined> {
    return (await this.read()).workflows[workflowId];
  }

  async set(workflowId: string, layout: CanvasWorkflowLayout): Promise<void> {
    validateLayout(layout);
    await this.mutate((document) => { document.workflows[workflowId] = layout; });
  }

  async remove(workflowId: string): Promise<void> {
    await this.mutate((document) => { delete document.workflows[workflowId]; });
  }

  private async read(): Promise<CanvasLayoutDocument> {
    if (!existsSync(this.file)) return { version: 1, workflows: {} };
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<CanvasLayoutDocument>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed.workflows !== undefined && (typeof parsed.workflows !== "object" || Array.isArray(parsed.workflows)))) {
        throw new Error("invalid layout document");
      }
      return { version: 1, workflows: parsed.workflows ?? {} };
    } catch {
      throw new Error(`Could not parse ${this.file}.`);
    }
  }

  private async mutate(operation: (document: CanvasLayoutDocument) => void): Promise<void> {
    // proper-lockfile needs a target file. Creating a valid empty document is
    // harmless and prevents simultaneous first saves from silently dropping a
    // collaborator's layout update.
    if (!existsSync(this.file)) await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, workflows: {} })}\n`);
    const release = await lockfile.lock(this.file, { retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 }, stale: 10_000 });
    try {
      const document = await this.read();
      operation(document);
      await writeFileAtomic(this.file, `${JSON.stringify(document, null, 2)}\n`);
    } finally { await release(); }
  }
}

function validateLayout(layout: CanvasWorkflowLayout): void {
  if (!layout || typeof layout !== "object" || Array.isArray(layout) || !layout.nodes || typeof layout.nodes !== "object" || Array.isArray(layout.nodes)) {
    throw new Error("Canvas layout must contain a nodes object.");
  }
  for (const [nodeId, position] of Object.entries(layout.nodes)) {
    if (!nodeId || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new Error("Canvas node positions must have an id and finite x/y coordinates.");
    }
  }
  if (layout.viewport && (!Number.isFinite(layout.viewport.x) || !Number.isFinite(layout.viewport.y) || !Number.isFinite(layout.viewport.zoom))) {
    throw new Error("Canvas viewport values must be finite numbers.");
  }
  if (layout.groups && !Array.isArray(layout.groups)) throw new Error("Canvas groups must be an array.");
  if (layout.notes && !Array.isArray(layout.notes)) throw new Error("Canvas notes must be an array.");
}
