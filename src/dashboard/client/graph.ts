import type { Edge, Node } from "@xyflow/react";
import type { Json, WorkflowSummary } from "./api.js";

export type GraphNodeData = { label: string; use: string; kind: "trigger" | "action"; config: Json; status?: string; schema?: Json };
export type GraphNode = Node<GraphNodeData>;

/**
 * References between the modular terminal/codex actions are represented in
 * `with`, but they also imply a workflow dependency. Keeping the mapping in
 * the client graph adapter lets the property panel and YAML round-trip share
 * one definition.
 */
export const ACTION_REFERENCES = {
  // Terminal commands, including Codex's remote TUI, target the existing pane
  // of a tmux window created earlier in the workflow.
  "worker-send": { path: "worker", upstreamUse: "tmux.create-window", label: "terminal", value: "action" },
  "codex.start-session": { path: "tmux", upstreamUse: "tmux.create-window", label: "tmux window", value: "action" },
  "codex.send-prompt": { path: "codex", upstreamUse: "codex.start-session", label: "Codex session", value: "action" },
} as const;

export type ActionReferencePath = (typeof ACTION_REFERENCES)[keyof typeof ACTION_REFERENCES]["path"];

export function actionReferenceFor(use: string) {
  return ACTION_REFERENCES[use as keyof typeof ACTION_REFERENCES];
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Json)[part] : undefined, value);
}

/** Read a worker/action reference from an action's `with` configuration. */
export function actionReferenceValue(config: Json | undefined, path: string, format: "action" | "string" = "action"): string | undefined {
  const withConfig = config?.with && typeof config.with === "object" ? config.with as Json : {};
  const raw = pathValue(withConfig, path);
  if (format === "string") return typeof raw === "string" ? raw : undefined;
  const reference = raw && typeof raw === "object" ? raw as Json : undefined;
  return typeof reference?.action === "string" ? reference.action : undefined;
}

const needSource = (need: unknown): string | undefined => {
  if (need && typeof need === "object") return typeof (need as Json).job === "string" ? (need as Json).job : undefined;
  return typeof need === "string" ? need : undefined;
};

/** Match a dependency to an ID without treating dots in the ID as a status separator. */
function needReferencesAction(need: unknown, actionId: string): boolean {
  const source = needSource(need);
  return source === actionId || (typeof source === "string" && source.startsWith(`${actionId}.`));
}

/** Parse Relay's `job.status` shorthand using the complete set of job IDs. */
function parseNeed(need: unknown, knownJobIds: readonly string[]): { source: string; condition?: string } {
  if (need && typeof need === "object") {
    const objectNeed = need as Json;
    return { source: String(objectNeed.job), condition: typeof objectNeed.status === "string" ? objectNeed.status : undefined };
  }
  const value = String(need);
  const source = [...knownJobIds].sort((left, right) => right.length - left.length)
    .find((id) => value === id || value.startsWith(`${id}.`));
  if (source) return { source, condition: value.slice(source.length + 1) || undefined };
  // Keep malformed/legacy values visible as dangling edges so the editor can
  // prevent saving them instead of silently changing workflow semantics.
  const separator = value.indexOf(".");
  return separator < 0
    ? { source: value }
    : { source: value.slice(0, separator), condition: value.slice(separator + 1) || undefined };
}

/** Candidates are earlier action nodes that can safely become an upstream dependency. */
export function upstreamReferenceNodes(nodes: GraphNode[], edges: Edge[], targetId: string, use: string): GraphNode[] {
  const targetIndex = nodes.findIndex((node) => node.id === targetId);
  return nodes.filter((node, index) => node.data.kind === "action"
    && node.data.use === use
    && node.id !== targetId
    && (targetIndex < 0 || index < targetIndex)
    && !wouldCycle(edges, node.id, targetId));
}

/** Update one modular action reference without disturbing the other `with` fields. */
export function setActionReference(config: Json, path: string, actionId?: string, value: "action" | "string" = "action"): Json {
  const withConfig = config.with && typeof config.with === "object" ? { ...config.with as Json } : {};
  const parts = path.split(".");
  let cursor = withConfig;
  for (const part of parts.slice(0, -1)) {
    const child = cursor[part];
    cursor[part] = child && typeof child === "object" && !Array.isArray(child) ? { ...child as Json } : {};
    cursor = cursor[part] as Json;
  }
  const leaf = parts[parts.length - 1]!;
  if (actionId) cursor[leaf] = value === "string" ? actionId : { action: actionId };
  else {
    delete cursor[leaf];
    // Avoid leaving an empty workspace object behind when its only field was
    // the selected action reference; preserve it when it has other settings.
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      const parentPath = parts.slice(0, index + 1);
      const parent = pathValue(withConfig, parentPath.join("."));
      if (!parent || typeof parent !== "object" || Object.keys(parent).length > 0) break;
      const container = index === 0 ? withConfig : pathValue(withConfig, parts.slice(0, index).join(".")) as Json;
      if (container && typeof container === "object") delete container[parts[index]!];
    }
  }
  return { ...config, with: withConfig };
}

/**
 * Keep the edge corresponding to a modular reference in sync with its
 * selected node. Existing hand-drawn edges are retained unless they were
 * identified as the old reference edge during graph import.
 */
export function syncActionReferenceEdge(edges: Edge[], targetId: string, path: string, previousActionId: string | undefined, nextActionId: string | undefined): Edge[] {
  let next = edges;
  if (previousActionId && previousActionId !== nextActionId) {
    next = next.filter((edge) => !(edge.target === targetId && edge.source === previousActionId
      && (edge.data as { relayReferencePath?: string } | undefined)?.relayReferencePath === path));
  }
  if (!nextActionId) return next;
  const existing = next.find((edge) => edge.source === nextActionId && edge.target === targetId);
  if (existing) {
    return next.map((edge) => edge !== existing ? edge : {
      ...edge,
      label: "started",
      data: { ...(edge.data ?? {}), relayReferencePath: path },
    });
  }
  return [...next, {
    id: `${nextActionId}-${targetId}`,
    source: nextActionId,
    target: targetId,
    type: "smoothstep",
    // A prompt can either steer the active turn or wait until it is idle. The
    // producer therefore only needs to have started; requiring success would
    // make the `immediate` delivery mode impossible to use from the canvas.
    label: "started",
    animated: false,
    data: { relayReferencePath: path },
  }];
}

export function workflowToGraph(workflow: WorkflowSummary, schemas: Record<string, any> = {}): { nodes: GraphNode[]; edges: Edge[] } {
  const sourceUse = workflow.source ?? workflow.on?.source ?? "";
  const nodes: GraphNode[] = [{ id: "trigger", type: "trigger", deletable: false, position: { x: 50, y: 160 }, data: { label: "On " + (sourceUse || "source"), use: sourceUse, kind: "trigger", config: workflow.on?.match ?? {}, schema: (schemas[`source:${sourceUse}`] ?? schemas[sourceUse])?.schema } }];
  const jobs = workflow.jobs ?? {};
  const entries = Array.isArray(jobs) ? jobs.map((job: any) => [job.id, job] as const) : Object.entries(jobs);
  const edges: Edge[] = [];
  const knownJobIds = entries.map(([id]) => String(id));
  entries.forEach(([id, job], index) => {
    const use = job.use ?? job.uses ?? "command";
    nodes.push({ id, type: "action", position: { x: 330 + (index % 3) * 260, y: 80 + Math.floor(index / 3) * 170 }, data: { label: id, use, kind: "action", config: { ...job, with: job.with ?? {} }, status: workflow.runs?.[0]?.jobs?.[id]?.status, schema: (schemas[`action:${use}`] ?? schemas[use])?.schema } });
    // Cleanup is a worker-targeted terminal action. Its workers are resolved
    // from workflow.targets and the matched source item, so it is standalone
    // by default and must not acquire a trigger/upstream dependency edge.
    const needs = job.needs === undefined && use === "cleanup" ? [] : (job.needs === undefined ? ["trigger"] : (Array.isArray(job.needs) ? job.needs : [job.needs]));
    needs.forEach((need: any) => {
      const parsed = parseNeed(need, knownJobIds);
      const source = parsed.source;
      const condition = parsed.condition;
      const reference = actionReferenceFor(use);
      const referencePath = reference?.path;
      const relayReferencePath = referencePath && source !== "trigger" && actionReferenceValue(job, referencePath, reference?.value) === source ? referencePath : undefined;
      const dangling = source !== "trigger" && !knownJobIds.includes(source);
      edges.push({ id: `${source}-${id}`, source: source === "trigger" ? "trigger" : source, target: id, label: condition, animated: false, ...(relayReferencePath ? { data: { relayReferencePath } } : {}), ...(dangling ? { data: { dangling: true, relayNeed: need } } : {}) });
    });
    // A reference may have been authored without a matching `needs` entry
    // (for example by the raw editor). Materialize it as the canonical
    // started edge so the graph and the serialized workflow agree.
    const reference = actionReferenceFor(use);
    const referenceActionId = reference ? actionReferenceValue(job, reference.path, reference.value) : undefined;
    if (referenceActionId) {
      const existing = edges.find((edge) => edge.source === referenceActionId && edge.target === id);
      if (existing) {
        existing.label = "started";
        existing.data = { ...(existing.data ?? {}), relayReferencePath: reference.path };
      } else {
        edges.push({
          id: `${referenceActionId}-${id}`,
          source: referenceActionId,
          target: id,
          type: "smoothstep",
          label: "started",
          animated: false,
          ...(knownJobIds.includes(referenceActionId) ? { data: { relayReferencePath: reference.path } } : { data: { dangling: true, relayReferencePath: reference.path } }),
        });
      }
    }
  });
  return { nodes, edges };
}

/** Return canvas edges whose endpoints no longer exist in the current graph. */
export function findDanglingEdges(nodes: GraphNode[], edges: Edge[]): Edge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return edges.filter((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target));
}

export interface DanglingActionReference {
  nodeId: string;
  path: string;
  actionId: string;
}

/** Find references whose producer was deleted or changed to another action kind. */
export function findDanglingActionReferences(nodes: GraphNode[]): DanglingActionReference[] {
  return nodes.flatMap((node) => {
    if (node.data.kind !== "action") return [];
    const reference = actionReferenceFor(node.data.use);
    const actionId = reference ? actionReferenceValue(node.data.config, reference.path, reference.value) : undefined;
    if (!reference || !actionId) return [];
    const producer = nodes.find((candidate) => candidate.id === actionId);
    return producer?.data.kind === "action" && producer.data.use === reference.upstreamUse
      ? []
      : [{ nodeId: node.id, path: reference.path, actionId }];
  });
}

export function graphToWorkflow(graph: { nodes: GraphNode[]; edges: Edge[] }, original: WorkflowSummary): WorkflowSummary {
  const trigger = graph.nodes.find((node) => node.data.kind === "trigger");
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  // Older canvas snapshots split dotted job ids at the first dot (for example
  // `tmux.create-window-1` became `tmux`). Resolve that legacy source when it
  // is unambiguous, so a subsequent save cannot reintroduce the truncated job
  // reference. Exact ids win because a workflow may legitimately contain a
  // job called `tmux` alongside dotted ids.
  const resolveEdgeSource = (edge: Edge): string | undefined => {
    if (nodeIds.has(edge.source)) return edge.source;
    const candidates = [...nodeIds].filter((id) => id.startsWith(`${edge.source}.`));
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const jobs: Json = {};
  graph.nodes.filter((node) => node.data.kind === "action").forEach((node) => {
    // Never serialize an edge to a job that has disappeared from the canvas.
    // The editor separately reports these edges so saving cannot hide a graph
    // corruption, while action dry-runs remain safe to construct.
    const incoming = graph.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => ({ edge, source: resolveEdgeSource(edge) }))
      .filter((entry): entry is { edge: Edge; source: string } => entry.source !== undefined);
    const old = node.data.config ?? {};
    const needs = [...new Set(incoming.map(({ edge, source }) => source === "trigger"
      ? undefined
      : (edge.label ? `${source}.${edge.label}` : source)).filter(Boolean))];
    const job = { ...old, use: node.data.use, with: old.with ?? {} } as Json;
    delete job.id;
    const reference = actionReferenceFor(node.data.use);
    const referenceActionId = reference ? actionReferenceValue(job, reference.path, reference.value) : undefined;
    if (referenceActionId) {
      // A selected action reference always means "started". Remove any stale
      // hand-drawn dependency to the same producer before adding the canonical
      // edge, so a previous `succeeded` edge cannot override the selector.
      for (let index = needs.length - 1; index >= 0; index -= 1) if (needReferencesAction(needs[index], referenceActionId)) needs.splice(index, 1);
      needs.push(`${referenceActionId}.started`);
    }
    if (needs.length) job.needs = needs.length === 1 ? needs[0] : needs;
    else delete job.needs;
    jobs[node.id] = job;
  });
  return { ...original, on: { ...(original.on ?? {}), source: trigger?.data.use ?? original.source, match: trigger?.data.config ?? {} }, source: trigger?.data.use ?? original.source, jobs } as WorkflowSummary;
}

export function wouldCycle(edges: Edge[], source: string, target: string): boolean {
  if (source === target) return true;
  const next = new Map<string, string[]>();
  [...edges, { source, target } as Edge].forEach((edge) => next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]));
  const seen = new Set<string>();
  const visit = (node: string): boolean => {
    if (node === source) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    return (next.get(node) ?? []).some(visit);
  };
  return visit(target);
}

export function autoLayout(nodes: GraphNode[], edges: Edge[]): GraphNode[] {
  const incoming = new Map(nodes.map((node) => [node.id, edges.filter((edge) => edge.target === node.id).map((edge) => edge.source)]));
  const levels = new Map<string, number>([["trigger", 0]]);
  let changed = true;
  while (changed) { changed = false; nodes.forEach((node) => { const parents = incoming.get(node.id) ?? []; if (parents.length && parents.every((p) => levels.has(p))) { const level = Math.max(...parents.map((p) => levels.get(p)!)) + 1; if (levels.get(node.id) !== level) { levels.set(node.id, level); changed = true; } } }); }
  const counts = new Map<number, number>();
  return nodes.map((node) => { const level = levels.get(node.id) ?? 0; const index = counts.get(level) ?? 0; counts.set(level, index + 1); return { ...node, position: { x: level * 280 + 40, y: index * 150 + 50 } }; });
}
