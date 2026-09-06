export type Json = Record<string, any>;
export interface ApiErrorContext {
  path: string;
  method: string;
  body?: unknown;
  cause?: unknown;
}
export class ApiError extends Error {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
  readonly cause?: unknown;

  constructor(
    public readonly status: number,
    message: string,
    context: Partial<ApiErrorContext> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.path = context.path ?? "";
    this.method = context.method ?? "GET";
    this.body = context.body;
    this.cause = context.cause;
  }
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface WatcherStatus {
  projectId: string;
  state: "stopped" | "running" | "blocked" | "failed";
  lastTickAt?: string;
  nextTickAt?: string;
  error?: string;
}
export interface ProjectFolder {
  id: string;
  repositoryId?: string;
  root: string;
  displayName?: string;
  enabled?: boolean;
  configStatus?: string;
  watcher?: WatcherStatus;
}
export interface WorkflowSummary {
  id: string;
  enabled?: boolean;
  source?: string;
  fire?: string;
  timeoutMinutes?: number;
  jobs?: JobSummary[] | Record<string, JobSummary>;
  runs?: WorkflowRun[];
  revision?: string | number;
  [key: string]: any;
}
export interface JobSummary {
  id?: string;
  use: string;
  needs?: string | string[];
  enabled?: boolean;
  [key: string]: any;
}
export interface WorkflowRun {
  id: string;
  status: string;
  item?: { id?: string; title?: string };
  jobs?: Record<string, any>;
  updatedAt?: string;
  [key: string]: any;
}
export interface ExecutionJobInspection {
  status?: string;
  attempts?: number;
  attempt?: unknown;
  attemptId?: string;
  waitReason?: string;
  message?: string;
  needsAttention?: boolean;
  retryAt?: string;
  resolvedInput?: unknown;
  input?: unknown;
  inputs?: unknown;
  output?: unknown;
  outputs?: unknown;
  operation?: unknown;
  operationHandle?: unknown;
  [key: string]: unknown;
}
export interface ExecutionInspection {
  id?: string;
  status?: string;
  item?: { id?: string; title?: string };
  identity?: { workflowId?: string; occurrence?: string };
  workflowId?: string;
  definitionRevision?: string | number;
  pluginRevisions?: Record<string, string>;
  trigger?: unknown;
  jobs?: Record<string, ExecutionJobInspection>;
  decisions?: Record<string, { reason?: string }>;
  updatedAt?: string;
  startedAt?: string;
  cancellation?: unknown;
  cancellationResult?: unknown;
  [key: string]: unknown;
}
export interface ExecutionDetail {
  execution: ExecutionInspection;
  inspection?: ExecutionInspection;
  jobs?: Record<string, ExecutionJobInspection>;
  events?: unknown;
  retryEligibility?: RetryEligibility;
}
export interface RetryEligibility {
  eligible: string[];
  ineligible: Array<{ id: string; status?: string; reason: string }>;
}
export interface RetryResult {
  execution?: ExecutionInspection;
  retryEligibility?: RetryEligibility;
  [key: string]: any;
}
export interface Worker {
  id: string;
  status?: string;
  task?: string;
  title?: string;
  workspace?: { path?: string };
  [key: string]: any;
}
export interface ActionTestMatch {
  id?: string;
  title?: string;
  eligible?: boolean;
  decision?: string;
  reason?: string;
  [key: string]: any;
}
export interface ActionTestResult {
  workflowId?: string;
  actionId?: string;
  matches: ActionTestMatch[];
  count: number;
  triggerMatchCount: number;
  eligibleCount: number;
  reasons: string[];
  [key: string]: any;
}
export interface WorkflowPreviewJob {
  id: string;
  use?: string;
  eligible: boolean;
  decision: "run" | "hold" | "settle";
  reason: string;
  status?: string;
}
export interface WorkflowPreviewItem {
  id: string;
  title: string;
  url?: string;
  state?: string;
  eligible: boolean;
  decision: "run" | "hold" | "settle";
  reason: string;
  jobs: WorkflowPreviewJob[];
  [key: string]: any;
}
export interface WorkflowTestResult {
  workflowId: string;
  sourceId: string;
  triggerMatchCount: number;
  eligibleCount: number;
  items: WorkflowPreviewItem[];
  [key: string]: any;
}
export interface CodexModelSummary {
  id: string;
  model: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
}
export interface PromptLibrary {
  directory: string;
  prompts: string[];
}
export interface LinearTriggerOptions {
  sourceId: string;
  labels: string[];
  statuses: Array<{ name: string; type?: string }>;
  users: Array<{ id: string; name: string }>;
}

/** Add the live App Server catalog to both supported dashboard catalog shapes. */
export function applyCodexModelCatalog(
  catalog: Json,
  models: CodexModelSummary[],
): Json {
  const values = models.map((model) => model.model || model.id).filter(Boolean);
  const efforts = [
    ...new Set(
      models.flatMap(
        (model) =>
          model.supportedReasoningEfforts?.map(
            (entry) => entry.reasoningEffort,
          ) ?? [],
      ),
    ),
  ];
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const apply = (schema: Json | undefined) => {
    if (!schema?.properties) return;
    if (values.length)
      schema.properties.model = {
        ...schema.properties.model,
        type: "string",
        title: "Codex model",
        enum: values,
        default: defaultModel?.model || defaultModel?.id,
      };
    if (efforts.length)
      schema.properties.effort = {
        ...schema.properties.effort,
        type: "string",
        title: "Reasoning effort",
        enum: efforts,
        default: defaultModel?.defaultReasoningEffort,
      };
  };
  for (const key of ["action:codex.send-prompt", "codex.send-prompt"])
    apply(catalog.schemas?.[key]?.schema);
  for (const entry of Array.isArray(catalog.entries) ? catalog.entries : []) {
    if (entry?.kind === "action" && entry?.use === "codex.send-prompt")
      apply(entry.configSchema ?? entry.schema);
  }
  return catalog;
}

export async function request<T>(
  path: string,
  init?: RequestOptions,
): Promise<T> {
  const { timeoutMs, signal, ...fetchInit } = init ?? {};
  const method = fetchInit.method ?? "GET";
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs < 0)
    throw new RangeError("timeoutMs must be a finite non-negative number.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach: (() => void) | undefined;
  if (controller) {
    if (signal?.aborted) controller.abort(signal.reason);
    else if (signal) {
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      detach = () => signal.removeEventListener("abort", abort);
    }
    timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Request timed out after ${effectiveTimeoutMs}ms.`),
        ),
      effectiveTimeoutMs,
    );
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...fetchInit,
      ...(controller
        ? { signal: controller.signal }
        : signal
          ? { signal }
          : {}),
      headers: {
        "Content-Type": "application/json",
        ...(fetchInit.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: any = {};
    let parseError: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      parseError = error;
      body = { error: text };
    }
    if (response.ok && parseError) {
      throw new ApiError(502, "The dashboard returned malformed JSON.", {
        path,
        method,
        body,
        cause: parseError,
      });
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        body.error ?? body.message ?? `Request failed (${response.status})`,
        { path, method, body },
      );
    return body as T;
  } catch (error) {
    if (controller?.signal.aborted && !signal?.aborted) {
      throw new ApiError(
        408,
        `Request timed out after ${effectiveTimeoutMs}ms.`,
        { path, method, cause: error },
      );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detach?.();
  }
}

function idFor(project: ProjectFolder): string {
  return encodeURIComponent(project.id || project.root);
}
function malformedResponse(
  path: string,
  expected: string,
  body: unknown,
): never {
  throw new ApiError(
    502,
    `The dashboard returned an invalid ${expected} response.`,
    { path, method: "GET", body },
  );
}
function arrayResult(
  result: any,
  key: string,
  path: string,
  expected: string,
): any[] {
  const value = Array.isArray(result)
    ? result
    : result && Array.isArray(result[key])
      ? result[key]
      : undefined;
  return value ?? malformedResponse(path, expected, result);
}

export async function getProjects(): Promise<ProjectFolder[]> {
  const path = "/api/projects";
  return arrayResult(
    await request<any>(path),
    "projects",
    path,
    "projects",
  ) as ProjectFolder[];
}
export async function registerProject(root: string): Promise<ProjectFolder> {
  const result = await request<any>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ root }),
  });
  return result.project ?? result;
}
export async function removeProject(project: ProjectFolder): Promise<void> {
  await request(`/api/projects/${idFor(project)}`, { method: "DELETE" });
}
export async function controlProject(
  project: ProjectFolder,
  action: "sync" | "start" | "stop",
): Promise<Json> {
  return request(`/api/projects/${idFor(project)}/${action}`, {
    method: "POST",
  });
}
export async function getWatcherStatuses(): Promise<WatcherStatus[]> {
  const path = "/api/supervisor";
  const result = await request<any>(path);
  return arrayResult(
    result,
    "projects",
    path,
    "supervisor projects",
  ) as WatcherStatus[];
}
export async function getWorkflows(
  project?: ProjectFolder,
): Promise<WorkflowSummary[]> {
  const path = project
    ? `/api/projects/${idFor(project)}/workflows`
    : "/api/workflows";
  return arrayResult(
    await request<any>(path),
    "workflows",
    path,
    "workflows",
  ) as WorkflowSummary[];
}
export async function getExecutions(project?: ProjectFolder): Promise<any[]> {
  const path = `/api/executions${project ? `?folderId=${idFor(project)}` : ""}`;
  const result = await request<any>(path);
  const executions = Array.isArray(result)
    ? result
    : Array.isArray(result?.executions)
      ? result.executions
      : undefined;
  return executions ?? malformedResponse(path, "executions", result);
}
export async function getExecution(id: string): Promise<ExecutionDetail> {
  return request(`/api/executions/${encodeURIComponent(id)}`);
}
export async function retryExecution(
  id: string,
  jobIds?: string[],
): Promise<RetryResult> {
  return request(`/api/executions/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    body: JSON.stringify({ jobIds }),
  });
}
export async function getWorkers(project?: ProjectFolder): Promise<Worker[]> {
  const path = project
    ? `/api/projects/${idFor(project)}/workers`
    : "/api/workers";
  const result = await request<any>(path);
  const workers = Array.isArray(result)
    ? result
    : Array.isArray(result?.workers)
      ? result.workers
      : undefined;
  return workers ?? malformedResponse(path, "workers", result);
}
export async function getPlugins(project?: ProjectFolder): Promise<Json> {
  return request<Json>(
    project ? `/api/projects/${idFor(project)}/plugins` : "/api/plugins",
  );
}
export async function getCatalog(project?: ProjectFolder): Promise<Json> {
  const catalog = await request<Json>(
    project
      ? `/api/projects/${idFor(project)}/catalog`
      : "/api/plugins/schemas",
  );
  if (!project) return catalog;
  try {
    const result = await request<{ models: CodexModelSummary[] }>(
      `/api/projects/${idFor(project)}/codex/models`,
    );
    applyCodexModelCatalog(catalog, result.models);
    catalog.modelAvailability = { available: true, models: result.models };
  } catch (error) {
    // Model discovery is optional only when the capability is genuinely absent
    // on an older server. Authentication and provider/server failures still
    // reject the catalog request with their original ApiError context.
    if (!(error instanceof ApiError) || ![404, 501].includes(error.status))
      throw error;
    const details = apiErrorDetails(error);
    catalog.modelAvailability = { available: false, error: details };
    // Keep the existing Settings surface readable until it consumes the
    // structured modelAvailability field directly.
    catalog.modelCatalogError = details.message;
  }
  return catalog;
}
export async function getPrompts(
  project?: ProjectFolder,
): Promise<PromptLibrary> {
  return request<PromptLibrary>(
    project ? `/api/projects/${idFor(project)}/prompts` : "/api/prompts",
  );
}
export interface EditablePrompt { path: string; content: string; revision: string }
export function getPrompt(project: ProjectFolder, path: string) {
  return request<EditablePrompt>(`/api/projects/${idFor(project)}/prompts?path=${encodeURIComponent(path)}`);
}
export function savePrompt(project: ProjectFolder, path: string, content: string, revision: string | null) {
  return request<EditablePrompt>(`/api/projects/${idFor(project)}/prompts`, { method: "PUT", body: JSON.stringify({ path, content, revision }) });
}
export async function getLinearTriggerOptions(
  sourceId: string,
  project?: ProjectFolder,
): Promise<LinearTriggerOptions> {
  if (!project)
    throw new Error("A project folder is required to load Linear options");
  return request(
    `/api/projects/${idFor(project)}/sources/${encodeURIComponent(sourceId)}/linear-options`,
  );
}
export async function getConfig(
  project?: ProjectFolder,
): Promise<{ config: Json; path?: string }> {
  return request(
    project
      ? `/api/projects/${idFor(project)}/config/json`
      : "/api/config/json",
  );
}
export async function getConfigMtime(project?: ProjectFolder): Promise<number> {
  const result = await request<any>(
    project
      ? `/api/projects/${idFor(project)}/config/mtime`
      : "/api/config/mtime",
  );
  return result.mtime ?? 0;
}
export async function saveConfig(
  config: Json,
  project?: ProjectFolder,
): Promise<void> {
  await request(
    project
      ? `/api/projects/${idFor(project)}/config/json`
      : "/api/config/json",
    { method: "PUT", body: JSON.stringify({ config }) },
  );
}
export async function saveWorkflow(
  workflowId: string,
  workflow: Json,
  project?: ProjectFolder,
  expectedRevision?: string | number,
): Promise<Json> {
  if (!project)
    throw new Error("A project folder is required to save a workflow");
  return request(
    `/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}`,
    { method: "PUT", body: JSON.stringify({ workflow, expectedRevision }) },
  );
}
export async function createWorkflow(
  workflowId: string,
  workflow: Json,
  project?: ProjectFolder,
  expectedRevision?: string | number,
): Promise<Json> {
  if (!project)
    throw new Error("A project folder is required to create a workflow");
  return request(`/api/projects/${idFor(project)}/workflows`, {
    method: "POST",
    body: JSON.stringify({ id: workflowId, workflow, expectedRevision }),
  });
}
export async function renameWorkflow(
  workflowId: string,
  nextWorkflowId: string,
  project?: ProjectFolder,
  expectedRevision?: string | number,
): Promise<Json> {
  if (!project)
    throw new Error("A project folder is required to rename a workflow");
  return request<Json>(
    `/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ nextWorkflowId, expectedRevision }),
    },
  );
}
export async function deleteWorkflow(
  workflowId: string,
  project?: ProjectFolder,
  expectedRevision?: string | number,
): Promise<void> {
  if (!project)
    throw new Error("A project folder is required to delete a workflow");
  await request(
    `/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}`,
    { method: "DELETE", body: JSON.stringify({ expectedRevision }) },
  );
}
export async function getLayout(
  workflowId: string,
  project?: ProjectFolder,
): Promise<Json | undefined> {
  if (!project) return undefined;
  const result = await request<Json>(
    `/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}/layout`,
  );
  return result.layout ?? result;
}
export async function saveLayout(
  workflowId: string,
  layout: Json,
  project?: ProjectFolder,
): Promise<void> {
  if (!project) return;
  const nodes = Array.isArray(layout.nodes)
    ? Object.fromEntries(
        layout.nodes.map((node: any) => [node.id, { x: node.x, y: node.y }]),
      )
    : layout.nodes;
  await request(
    `/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}/layout`,
    { method: "PUT", body: JSON.stringify({ ...layout, nodes }) },
  );
}
export async function testWorkflow(
  id: string,
  project?: ProjectFolder,
): Promise<Json> {
  return request(
    project
      ? `/api/projects/${idFor(project)}/workflows/${encodeURIComponent(id)}/test`
      : `/api/workflows/${encodeURIComponent(id)}/test`,
    { method: "POST" },
  );
}
export async function testWorkflowDraft(
  id: string,
  workflow: Json,
  project?: ProjectFolder,
): Promise<WorkflowTestResult> {
  if (!project)
    throw new Error("A project folder is required to test a workflow draft");
  const path = `/api/projects/${idFor(project)}/workflows/${encodeURIComponent(id)}/test`;
  const raw = await request<any>(path, {
    method: "POST",
    body: JSON.stringify({ workflow }),
  });
  // Older dashboard processes accept the body but silently execute the saved
  // workflow preview. Never label that response as a draft result.
  if (raw?.draft !== true)
    throw new ApiError(
      501,
      "The dashboard server did not confirm draft workflow preview support.",
      { path, method: "POST", body: raw },
    );
  const result = raw?.result ?? raw?.data;
  if (
    !result ||
    result.workflowId !== id ||
    !Array.isArray(result.items) ||
    typeof result.triggerMatchCount !== "number" ||
    typeof result.eligibleCount !== "number"
  ) {
    throw new ApiError(
      502,
      "The dashboard returned an invalid draft workflow preview.",
      { path, method: "POST", body: raw },
    );
  }
  return result;
}
export async function testAction(
  workflowId: string,
  actionId: string,
  project?: ProjectFolder,
  payload?: { workflow?: Json; action?: Json },
): Promise<ActionTestResult> {
  if (!project)
    throw new Error("A project folder is required to test an action");
  const raw = await request<any>(
    `/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}/actions/${encodeURIComponent(actionId)}/test`,
    {
      method: "POST",
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    },
  );
  const value = raw?.result ?? raw?.data ?? raw;
  const rawMatches = value?.matches ?? value?.items ?? value?.results ?? [];
  const matches = (Array.isArray(rawMatches) ? rawMatches : []).map(
    (entry: any) => {
      const item = entry?.item ?? entry?.ticket ?? entry;
      return {
        ...entry,
        id:
          entry?.id ??
          entry?.identifier ??
          item?.id ??
          item?.identifier ??
          item?.key,
        title: entry?.title ?? item?.title ?? item?.name,
        eligible:
          typeof entry?.eligible === "boolean"
            ? entry.eligible
            : typeof entry?.canRun === "boolean"
              ? entry.canRun
              : undefined,
        decision: entry?.decision ?? entry?.actionDecision,
        reason: entry?.reason ?? entry?.ineligibleReason ?? entry?.message,
      };
    },
  );
  const numberValue = (...values: any[]): number | undefined =>
    values.find((entry) => typeof entry === "number" && Number.isFinite(entry));
  const hasEligibility = matches.some(
    (entry) => typeof entry.eligible === "boolean",
  );
  const count =
    numberValue(value?.count, value?.total, value?.matchCount) ??
    matches.length;
  const triggerMatchCount =
    numberValue(
      value?.triggerMatchCount,
      value?.triggerMatchesCount,
      value?.triggerCount,
      value?.matchCount,
      value?.count,
    ) ?? matches.length;
  const eligibleCount =
    numberValue(
      value?.eligibleCount,
      value?.currentlyEligibleCount,
      value?.runnableCount,
    ) ??
    (hasEligibility ? matches.filter((entry) => entry.eligible).length : count);
  const reasons = (Array.isArray(value?.reasons) ? value.reasons : [])
    .map((reason: any) =>
      typeof reason === "string"
        ? reason
        : String(reason?.reason ?? reason?.message ?? reason),
    )
    .filter(Boolean);
  return {
    ...value,
    workflowId: value?.workflowId ?? workflowId,
    actionId: value?.actionId ?? actionId,
    matches,
    count,
    triggerMatchCount,
    eligibleCount,
    reasons,
  };
}
export async function controlWorker(
  id: string,
  action: "send" | "exec",
  body: Json,
  project?: ProjectFolder,
): Promise<void> {
  await request(
    project
      ? `/api/projects/${idFor(project)}/workers/${encodeURIComponent(id)}/${action}`
      : `/api/workers/${encodeURIComponent(id)}/${action}`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

function apiErrorDetails(error: unknown): Json {
  if (error instanceof ApiError)
    return {
      status: error.status,
      message: error.message,
      path: error.path,
      method: error.method,
      body: error.body,
    };
  return { message: error instanceof Error ? error.message : String(error) };
}
