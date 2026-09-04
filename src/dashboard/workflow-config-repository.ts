import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { parseDocument, type Document } from "yaml";
import { ZodError } from "zod";
import { CONFIG_FILE } from "../config/load.js";
import { normalizeRelayConfig, type RelayWorkflowV2 } from "../config/v2.js";

export class WorkflowRevisionConflictError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super("The workflow configuration changed after it was opened. Reload it before saving.");
    this.name = "WorkflowRevisionConflictError";
  }
}

export class WorkflowNotFoundError extends Error {
  constructor(readonly workflowId: string) {
    super(`Unknown workflow '${workflowId}'.`);
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowAlreadyExistsError extends Error {
  constructor(readonly workflowId: string) {
    super(`Workflow '${workflowId}' already exists.`);
    this.name = "WorkflowAlreadyExistsError";
  }
}

export interface WorkflowConfigSnapshot {
  workflowId: string;
  workflow: RelayWorkflowV2;
  revision: string;
  configPath: string;
}

/**
 * Performs small, revision-checked updates against the YAML document rather
 * than rendering the normalized config back from scratch. Comments, aliases,
 * formatting, and sections the dashboard does not understand stay intact.
 */
export class WorkflowConfigRepository {
  readonly configPath: string;

  constructor(readonly projectRoot: string) {
    this.configPath = resolve(projectRoot, CONFIG_FILE);
  }

  async list(): Promise<WorkflowConfigSnapshot[]> {
    const snapshot = await this.read();
    return Object.entries(snapshot.config.workflows).map(([workflowId, workflow]) => ({
      workflowId,
      workflow,
      revision: snapshot.revision,
      configPath: this.configPath,
    }));
  }

  async get(workflowId: string): Promise<WorkflowConfigSnapshot> {
    const snapshot = await this.read();
    const workflow = snapshot.config.workflows[workflowId];
    if (!workflow) throw new WorkflowNotFoundError(workflowId);
    return { workflowId, workflow, revision: snapshot.revision, configPath: this.configPath };
  }

  async save(workflowId: string, workflow: unknown, expectedRevision?: string): Promise<WorkflowConfigSnapshot> {
    return this.mutate(expectedRevision, (document) => {
      document.setIn(["workflows", workflowId], normalizeLegacyCodexTmuxNeeds(workflow));
    }).then(async () => this.get(workflowId));
  }

  /** Creates a workflow atomically; unlike save it never overwrites an existing id. */
  async create(workflowId: string, workflow: unknown, expectedRevision?: string): Promise<WorkflowConfigSnapshot> {
    await this.mutate(expectedRevision, (document) => {
      if (document.hasIn(["workflows", workflowId])) throw new WorkflowAlreadyExistsError(workflowId);
      document.setIn(["workflows", workflowId], normalizeLegacyCodexTmuxNeeds(workflow));
    });
    return this.get(workflowId);
  }

  async remove(workflowId: string, expectedRevision?: string): Promise<{ revision: string }> {
    return this.mutate(expectedRevision, (document) => {
      if (!document.hasIn(["workflows", workflowId])) throw new WorkflowNotFoundError(workflowId);
      document.deleteIn(["workflows", workflowId]);
    });
  }

  async rename(workflowId: string, nextWorkflowId: string, expectedRevision?: string): Promise<WorkflowConfigSnapshot> {
    if (!nextWorkflowId.trim()) throw new Error("A workflow name is required.");
    await this.mutate(expectedRevision, (document) => {
      const current = document.getIn(["workflows", workflowId], true);
      if (current === undefined) throw new WorkflowNotFoundError(workflowId);
      if (document.hasIn(["workflows", nextWorkflowId])) throw new Error(`Workflow '${nextWorkflowId}' already exists.`);
      document.setIn(["workflows", nextWorkflowId], current);
      document.deleteIn(["workflows", workflowId]);
    });
    return this.get(nextWorkflowId);
  }

  private async mutate(expectedRevision: string | undefined, operation: (document: Document) => void): Promise<{ revision: string }> {
    if (!existsSync(this.configPath)) throw new Error(`No ${CONFIG_FILE} found in ${this.projectRoot}.`);
    const release = await lockfile.lock(this.configPath, {
      retries: { retries: 6, factor: 1.4, minTimeout: 25, maxTimeout: 500 },
      stale: 10_000,
    });
    try {
      const content = await readFile(this.configPath, "utf8");
      const actual = revisionOf(content);
      if (expectedRevision && expectedRevision !== actual) throw new WorkflowRevisionConflictError(expectedRevision, actual);
      const document = parseDocument(content, { keepSourceTokens: true });
      if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("\n"));
      operation(document);
      normalizeDocumentLegacyNeeds(document);
      assertValidDocument(document);
      const rendered = document.toString({ lineWidth: 0 });
      await writeFileAtomic(this.configPath, rendered);
      return { revision: revisionOf(rendered) };
    } finally {
      await release();
    }
  }

  private async read(): Promise<{ config: ReturnType<typeof normalizeRelayConfig>; revision: string }> {
    if (!existsSync(this.configPath)) throw new Error(`No ${CONFIG_FILE} found in ${this.projectRoot}.`);
    const content = await readFile(this.configPath, "utf8");
    const document = parseDocument(content);
    if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("\n"));
    return { config: normalizeRelayConfig(document.toJS()), revision: revisionOf(content) };
  }
}

/** Apply only repaired `needs` fields so comments and formatting stay intact. */
function normalizeDocumentLegacyNeeds(document: Document): void {
  const raw = document.toJS() as Record<string, any>;
  for (const [workflowId, workflow] of Object.entries(raw.workflows ?? {})) {
    const normalized = normalizeLegacyCodexTmuxNeeds(workflow);
    const beforeJobs = raw.workflows?.[workflowId]?.jobs ?? {};
    const normalizedJobs = isRecord(normalized) && isRecord(normalized.jobs) ? normalized.jobs : {};
    for (const [jobId, job] of Object.entries(normalizedJobs)) {
      const before = beforeJobs[jobId]?.needs;
      const after = (job as any)?.needs;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const path = ["workflows", workflowId, "jobs", jobId, "needs"];
      if (after === undefined) document.deleteIn(path);
      else document.setIn(path, after);
    }
  }
}

/**
 * The first canvas version split dotted job ids at the first dot. This made a
 * dependency on `tmux.create-window-1` look like `tmux.succeeded` (or
 * `{ job: "tmux", status: "succeeded" }`). Resolve that legacy shorthand only
 * when there is exactly one possible dotted job. Ambiguous and genuinely
 * unknown dependencies deliberately remain validation errors.
 *
 * Dotted job ids are represented with object needs after repair. The string
 * syntax uses a dot for the status suffix, so it cannot unambiguously name a
 * dotted job id for the workflow validator.
 */
export function normalizeLegacyCodexTmuxNeeds(workflow: unknown): unknown {
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return workflow;
  const jobs = normalizeLegacyDottedNeeds(workflow.jobs);
  const jobIds = new Set(Object.keys(jobs));
  let changed = jobs !== workflow.jobs;
  const nextJobs: Record<string, unknown> = {};

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isRecord(job) || job.use !== "codex.start-session" || !isRecord(job.with) || !isRecord(job.with.tmux) || typeof job.with.tmux.action !== "string") {
      nextJobs[jobId] = job;
      continue;
    }
    const tmuxAction = job.with.tmux.action;
    const originalNeeds = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
    const needs = originalNeeds.filter((need) => !isObsoleteTmuxNeed(need, jobIds, tmuxAction));
    // A typed tmux reference always waits until its worker has been created.
    needs.push({ job: tmuxAction, status: "started" });
    nextJobs[jobId] = { ...job, needs: needs.length === 1 ? needs[0] : needs };
    changed = true;
  }
  return changed ? { ...workflow, jobs: nextJobs } : workflow;
}

function normalizeLegacyDottedNeeds(jobs: Record<string, any>): Record<string, any> {
  const jobIds = new Set(Object.keys(jobs));
  let changed = false;
  const normalized: Record<string, any> = { ...jobs };

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isRecord(job) || job.needs === undefined) continue;
    const rawNeeds = Array.isArray(job.needs) ? job.needs : [job.needs];
    const needs = rawNeeds.map((need) => normalizeLegacyDottedNeed(need, jobIds));
    if (sameValue(rawNeeds, needs)) continue;
    normalized[jobId] = { ...job, needs: Array.isArray(job.needs) ? needs : needs[0] };
    changed = true;
  }
  return changed ? normalized : jobs;
}

function normalizeLegacyDottedNeed(need: unknown, jobIds: ReadonlySet<string>): unknown {
  if (isRecord(need) && typeof need.job === "string") {
    const job = resolveLegacyDottedJob(need.job, jobIds);
    return job === need.job ? need : { ...need, job };
  }
  if (typeof need !== "string") return need;

  const { job: rawJob, status } = splitNeedStatus(need);
  const job = resolveLegacyDottedJob(rawJob, jobIds);
  if (job === rawJob && !(jobIds.has(job) && job.includes("."))) return need;

  // String needs cannot distinguish `job.status` from a dotted job id. Use
  // the object form whenever the repaired target contains a dot.
  if (job.includes(".")) return status === undefined ? { job } : { job, status };
  return status === undefined ? job : need;
}

function resolveLegacyDottedJob(source: string, jobIds: ReadonlySet<string>): string {
  if (jobIds.has(source)) return source;
  const truncated = source.split(".", 1)[0];
  // An exact job always wins. This prevents rewriting a deliberate `tmux`
  // dependency just because other jobs happen to share its prefix.
  if (jobIds.has(truncated)) return source;
  const matches = [...jobIds].filter((jobId) => jobId.startsWith(`${truncated}.`));
  return matches.length === 1 ? matches[0] : source;
}

function splitNeedStatus(need: string): { job: string; status?: string } {
  const match = /^(.*)\.(started|succeeded|failed|skipped)$/.exec(need);
  return match ? { job: match[1], status: match[2] } : { job: need };
}

function isObsoleteTmuxNeed(need: unknown, jobIds: ReadonlySet<string>, selectedTmuxAction: string): boolean {
  const target = needTarget(need);
  if (target === selectedTmuxAction) return true;
  // Do not rewrite a valid, deliberately named `tmux` job. This only handles
  // the former dotted-id truncation when no such job exists.
  return !jobIds.has("tmux") && target === "tmux";
}

function needTarget(need: unknown): string | undefined {
  if (isRecord(need)) return typeof need.job === "string" ? need.job : undefined;
  if (typeof need !== "string") return undefined;
  return splitNeedStatus(need).job;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertValidDocument(document: Document): void {
  try {
    normalizeRelayConfig(document.toJS());
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("\n"));
    }
    throw error;
  }
}

function revisionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
