export type Json = Record<string, any>;
export class ApiError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

export interface WatcherStatus { projectId: string; state: "stopped" | "running" | "blocked" | "failed"; lastTickAt?: string; nextTickAt?: string; error?: string; }
export interface ProjectFolder { id: string; repositoryId?: string; root: string; displayName?: string; enabled?: boolean; configStatus?: string; watcher?: WatcherStatus; }
export interface WorkflowSummary { id: string; enabled?: boolean; source?: string; fire?: string; timeoutMinutes?: number; jobs?: JobSummary[] | Record<string, JobSummary>; runs?: WorkflowRun[]; revision?: string | number; [key: string]: any; }
export interface JobSummary { id?: string; use: string; needs?: string[]; enabled?: boolean; [key: string]: any; }
export interface WorkflowRun { id: string; status: string; item?: { id?: string; title?: string }; jobs?: Record<string, any>; updatedAt?: string; [key: string]: any; }
export interface Worker { id: string; status?: string; task?: string; title?: string; workspace?: { path?: string }; [key: string]: any; }
export interface ActionTestMatch { id?: string; title?: string; eligible?: boolean; decision?: string; reason?: string; [key: string]: any; }
export interface ActionTestResult { workflowId?: string; actionId?: string; matches: ActionTestMatch[]; count: number; triggerMatchCount: number; eligibleCount: number; reasons: string[]; [key: string]: any; }
export interface CodexModelSummary {
  id: string;
  model: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
}

/** Add the live App Server catalog to both supported dashboard catalog shapes. */
export function applyCodexModelCatalog(catalog: Json, models: CodexModelSummary[]): Json {
  const values = models.map((model) => model.model || model.id).filter(Boolean);
  const efforts = [...new Set(models.flatMap((model) => model.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort) ?? []))];
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const apply = (schema: Json | undefined) => {
    if (!schema?.properties) return;
    if (values.length) schema.properties.model = { ...schema.properties.model, type: "string", title: "Codex model", enum: values, default: defaultModel?.model || defaultModel?.id };
    if (efforts.length) schema.properties.effort = { ...schema.properties.effort, type: "string", title: "Reasoning effort", enum: efforts, default: defaultModel?.defaultReasoningEffort };
  };
  for (const key of ["action:codex.start-session", "codex.start-session"]) apply(catalog.schemas?.[key]?.schema);
  for (const entry of Array.isArray(catalog.entries) ? catalog.entries : []) {
    if (entry?.kind === "action" && entry?.use === "codex.start-session") apply(entry.configSchema ?? entry.schema);
  }
  return catalog;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) throw new ApiError(response.status, body.error ?? body.message ?? `Request failed (${response.status})`);
  return body as T;
}

function idFor(project: ProjectFolder): string { return encodeURIComponent(project.id || project.root); }

export async function getProjects(): Promise<ProjectFolder[]> {
  try { const result = await request<any>("/api/projects"); return result.projects ?? result; }
  catch {
    const status = await request<any>("/api/status");
    return [{ id: status.project ?? "current", root: status.root ?? "", displayName: status.project, enabled: true }];
  }
}
export async function registerProject(root: string): Promise<ProjectFolder> {
  const result = await request<any>("/api/projects", { method: "POST", body: JSON.stringify({ root }) });
  return result.project ?? result;
}
export async function removeProject(project: ProjectFolder): Promise<void> {
  await request(`/api/projects/${idFor(project)}`, { method: "DELETE" });
}
export async function controlProject(project: ProjectFolder, action: "sync" | "start" | "stop"): Promise<Json> {
  return request(`/api/projects/${idFor(project)}/${action}`, { method: "POST" });
}
export async function getWatcherStatuses(): Promise<WatcherStatus[]> {
  try {
    const result = await request<{ projects?: WatcherStatus[] }>("/api/supervisor");
    return result.projects ?? [];
  } catch { return []; }
}
export async function getWorkflows(project?: ProjectFolder): Promise<WorkflowSummary[]> {
  try {
    const result = await request<any>(project ? `/api/projects/${idFor(project)}/workflows` : "/api/workflows");
    return result.workflows ?? result;
  } catch {
    try { const result = await request<any>("/api/workflows"); return result.workflows ?? result; } catch { return []; }
  }
}
export async function getExecutions(project?: ProjectFolder): Promise<any[]> {
  try {
    const result = await request<any>(`/api/executions${project ? `?folderId=${idFor(project)}` : ""}`);
    return result.executions ?? result.runs ?? result;
  } catch {
    try { const result = await request<any>(project ? `/api/projects/${idFor(project)}/executions` : "/api/runs"); return result.executions ?? result.runs ?? result; }
    catch { return []; }
  }
}
export async function getExecution(id: string): Promise<Json> { return request(`/api/executions/${encodeURIComponent(id)}`); }
export async function retryExecution(id: string, jobIds?: string[]): Promise<Json> { return request(`/api/executions/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({ jobIds }) }); }
export async function getWorkers(project?: ProjectFolder): Promise<Worker[]> {
  try {
    const result = await request<any>(project ? `/api/projects/${idFor(project)}/workers` : "/api/workers");
    return result.workers ?? result.runs ?? result;
  } catch {
    try { const result = await request<any>(project ? `/api/projects/${idFor(project)}/workers` : "/api/runs"); return result.workers ?? result.runs ?? result; }
    catch { return []; }
  }
}
export async function getPlugins(project?: ProjectFolder): Promise<Json> {
  try { return await request<Json>(project ? `/api/projects/${idFor(project)}/plugins` : "/api/plugins"); }
  catch { try { return await request<Json>("/api/plugins"); } catch { return { installed: [], referenced: [], errors: {} }; } }
}
export async function getCatalog(project?: ProjectFolder): Promise<Json> {
  try {
    const catalog = await request<Json>(project ? `/api/projects/${idFor(project)}/catalog` : "/api/plugins/schemas");
    if (!project) return catalog;
    try {
      const result = await request<{ models: CodexModelSummary[] }>(`/api/projects/${idFor(project)}/codex/models`);
      applyCodexModelCatalog(catalog, result.models);
    } catch {
      // Keep the schema's free-text fallback when Codex is not installed or
      // its local model catalog is temporarily unavailable.
    }
    return catalog;
  }
  catch { try { return await request<Json>("/api/plugins/schemas"); } catch { return { schemas: {} }; } }
}
export async function getConfig(project?: ProjectFolder): Promise<{ config: Json; path?: string }> {
  try { return await request(project ? `/api/projects/${idFor(project)}/config/json` : "/api/config/json"); }
  catch { return request("/api/config/json"); }
}
export async function getConfigMtime(project?: ProjectFolder): Promise<number> {
  try { const result = await request<any>(project ? `/api/projects/${idFor(project)}/config/mtime` : "/api/config/mtime"); return result.mtime ?? 0; } catch { try { const result = await request<any>("/api/config/mtime"); return result.mtime ?? 0; } catch { return 0; } }
}
export async function saveConfig(config: Json, project?: ProjectFolder): Promise<void> {
  try { await request(project ? `/api/projects/${idFor(project)}/config/json` : "/api/config/json", { method: "PUT", body: JSON.stringify({ config }) }); }
  catch (error) { if (project && error instanceof ApiError && [404, 501].includes(error.status)) await request("/api/config/json", { method: "PUT", body: JSON.stringify({ config }) }); else throw error; }
}
export async function saveWorkflow(workflowId: string, workflow: Json, project?: ProjectFolder, expectedRevision?: string | number): Promise<Json> {
  if (!project) throw new Error("A project folder is required to save a workflow");
  return request(`/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}`, { method: "PUT", body: JSON.stringify({ workflow, expectedRevision }) });
}
export async function createWorkflow(workflowId: string, workflow: Json, project?: ProjectFolder, expectedRevision?: string | number): Promise<Json> {
  if (!project) throw new Error("A project folder is required to create a workflow");
  return request(`/api/projects/${idFor(project)}/workflows`, { method: "POST", body: JSON.stringify({ id: workflowId, workflow, expectedRevision }) });
}
export async function renameWorkflow(workflowId: string, nextWorkflowId: string, project?: ProjectFolder, expectedRevision?: string | number): Promise<void> {
  if (!project) throw new Error("A project folder is required to rename a workflow");
  await request(`/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}`, { method: "PATCH", body: JSON.stringify({ nextWorkflowId, expectedRevision }) });
}
export async function deleteWorkflow(workflowId: string, project?: ProjectFolder, expectedRevision?: string | number): Promise<void> {
  if (!project) throw new Error("A project folder is required to delete a workflow");
  await request(`/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision }) });
}
export async function getLayout(workflowId: string, project?: ProjectFolder): Promise<Json | undefined> {
  if (!project) return undefined;
  try { const result = await request<Json>(`/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}/layout`); return result.layout ?? result; } catch { return undefined; }
}
export async function saveLayout(workflowId: string, layout: Json, project?: ProjectFolder): Promise<void> {
  if (!project) return;
  const nodes = Array.isArray(layout.nodes)
    ? Object.fromEntries(layout.nodes.map((node: any) => [node.id, { x: node.x, y: node.y }]))
    : layout.nodes;
  await request(`/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}/layout`, { method: "PUT", body: JSON.stringify({ ...layout, nodes }) });
}
export async function testWorkflow(id: string, project?: ProjectFolder): Promise<Json> {
  return request(project ? `/api/projects/${idFor(project)}/workflows/${encodeURIComponent(id)}/test` : `/api/workflows/${encodeURIComponent(id)}/test`, { method: "POST" });
}
export async function testAction(workflowId: string, actionId: string, project?: ProjectFolder, payload?: { workflow?: Json; action?: Json }): Promise<ActionTestResult> {
  if (!project) throw new Error("A project folder is required to test an action");
  const raw = await request<any>(`/api/projects/${idFor(project)}/workflows/${encodeURIComponent(workflowId)}/actions/${encodeURIComponent(actionId)}/test`, {
    method: "POST",
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const value = raw?.result ?? raw?.data ?? raw;
  const rawMatches = value?.matches ?? value?.items ?? value?.results ?? [];
  const matches = (Array.isArray(rawMatches) ? rawMatches : []).map((entry: any) => {
    const item = entry?.item ?? entry?.ticket ?? entry;
    return {
      ...entry,
      id: entry?.id ?? entry?.identifier ?? item?.id ?? item?.identifier ?? item?.key,
      title: entry?.title ?? item?.title ?? item?.name,
      eligible: typeof entry?.eligible === "boolean" ? entry.eligible : typeof entry?.canRun === "boolean" ? entry.canRun : undefined,
      decision: entry?.decision ?? entry?.actionDecision,
      reason: entry?.reason ?? entry?.ineligibleReason ?? entry?.message,
    };
  });
  const numberValue = (...values: any[]): number | undefined => values.find((entry) => typeof entry === "number" && Number.isFinite(entry));
  const hasEligibility = matches.some((entry) => typeof entry.eligible === "boolean");
  const count = numberValue(value?.count, value?.total, value?.matchCount) ?? matches.length;
  const triggerMatchCount = numberValue(value?.triggerMatchCount, value?.triggerMatchesCount, value?.triggerCount, value?.matchCount, value?.count) ?? matches.length;
  const eligibleCount = numberValue(value?.eligibleCount, value?.currentlyEligibleCount, value?.runnableCount) ?? (hasEligibility ? matches.filter((entry) => entry.eligible).length : count);
  const reasons = (Array.isArray(value?.reasons) ? value.reasons : []).map((reason: any) => typeof reason === "string" ? reason : String(reason?.reason ?? reason?.message ?? reason)).filter(Boolean);
  return { ...value, workflowId: value?.workflowId ?? workflowId, actionId: value?.actionId ?? actionId, matches, count, triggerMatchCount, eligibleCount, reasons };
}
export async function controlWorker(id: string, action: "send" | "exec", body: Json, project?: ProjectFolder): Promise<void> {
  try { await request(project ? `/api/projects/${idFor(project)}/workers/${encodeURIComponent(id)}/${action}` : `/api/workers/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(body) }); }
  catch (error) { if (project && error instanceof ApiError && [404, 501].includes(error.status)) await request(`/api/workers/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify(body) }); else throw error; }
}
