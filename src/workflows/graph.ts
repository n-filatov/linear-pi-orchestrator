import type {
  RelayWorkflowJobV2,
  RelayWorkflowNeedV2,
  RelayWorkflowV2,
} from "../config/v2.js";

export type WorkflowEdgeCondition = "matched" | "started" | "succeeded" | "failed" | "skipped";
type WorkflowDependencyCondition = Exclude<WorkflowEdgeCondition, "matched">;

export interface WorkflowTriggerNode {
  id: string;
  kind: "trigger";
  /** The configured source id, as used by `workflow.on.source`. */
  use: string;
  /** The source-owned `workflow.on.match` object. */
  config: unknown;
  fire?: RelayWorkflowV2["on"]["fire"];
}

export interface WorkflowActionNode {
  id: string;
  kind: "action";
  use: string;
  /** The action-owned `with` configuration. */
  config: unknown;
  enabled?: boolean;
  continueOnError?: boolean;
  /** The GitHub-style `if:` expression. */
  condition?: string;
  timeoutMinutes?: number;
  strategy?: RelayWorkflowJobV2["strategy"];
}

export type WorkflowNode = WorkflowTriggerNode | WorkflowActionNode;

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  condition: WorkflowEdgeCondition;
  /**
   * Original Relay syntax, retained so a YAML round trip keeps string and
   * object `needs` entries exactly where a visual edit has not changed them.
   */
  relayNeed?: RelayWorkflowNeedV2;
}

export interface WorkflowGraphSettings {
  maxConcurrent?: number;
  targets?: RelayWorkflowV2["targets"];
  timeoutMinutes?: number;
  concurrency?: RelayWorkflowV2["concurrency"];
  /** A reusable workflow cannot also carry action nodes. */
  reusable?: { use: string; with?: RelayWorkflowV2["with"] };
}

/** A UI-neutral projection of a Relay workflow. Layout belongs in `.task-relay.ui.json`, not here. */
export interface WorkflowGraph {
  id: string;
  name?: string;
  enabled: boolean;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  settings?: WorkflowGraphSettings;
}

export interface WorkflowGraphValidationIssue {
  path: string;
  message: string;
}

const statusConditions = new Set<WorkflowEdgeCondition>(["started", "succeeded", "failed", "skipped"]);

function needsList(needs: RelayWorkflowJobV2["needs"]): readonly RelayWorkflowNeedV2[] {
  if (needs === undefined) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/** Matches Relay's currently-supported `job.Status` shorthand. */
function needParts(need: RelayWorkflowNeedV2): { job: string; condition: WorkflowDependencyCondition } {
  if (typeof need !== "string") return { job: need.job, condition: need.status ?? "succeeded" };
  const [job, suffix] = need.split(".", 2);
  if (!suffix) return { job, condition: "succeeded" };
  const candidate = suffix.toLowerCase();
  if (!statusConditions.has(candidate as WorkflowEdgeCondition)) {
    throw new Error(`Unknown job status '${suffix}' in needs '${need}'. Use Started, Succeeded, Failed, or Skipped.`);
  }
  return { job, condition: candidate as WorkflowDependencyCondition };
}

function needsEquivalent(need: RelayWorkflowNeedV2, source: string, condition: WorkflowDependencyCondition): boolean {
  const parsed = needParts(need);
  return parsed.job === source && parsed.condition === condition;
}

/** Convert one parsed Relay workflow into an editable neutral graph. */
export function relayWorkflowToGraph(id: string, workflow: RelayWorkflowV2): WorkflowGraph {
  const triggerId = "__trigger__";
  const nodes: WorkflowNode[] = [{
    id: triggerId,
    kind: "trigger",
    use: workflow.on.source,
    config: workflow.on.match,
    fire: workflow.on.fire,
  }];
  const edges: WorkflowEdge[] = [];
  const jobs = workflow.jobs ?? {};
  for (const [jobId, job] of Object.entries(jobs)) {
    nodes.push({
      id: jobId,
      kind: "action",
      use: job.use,
      config: job.with,
      enabled: job.enabled,
      continueOnError: job.continueOnError,
      condition: job.if,
      strategy: job.strategy,
      timeoutMinutes: job.timeoutMinutes,
    });
    for (const [index, need] of needsList(job.needs).entries()) {
      const parts = needParts(need);
      edges.push({ id: `${parts.job}--${jobId}--${index}`, source: parts.job, target: jobId, condition: parts.condition, relayNeed: need });
    }
  }
  // A trigger edge is visual information. Relay infers it from a job having no
  // `needs`, so it is deliberately ignored by graphToRelayWorkflow.
  for (const jobId of Object.keys(jobs)) {
    if (!edges.some((edge) => edge.target === jobId && edge.source !== triggerId)) {
      edges.push({ id: `${triggerId}--${jobId}`, source: triggerId, target: jobId, condition: "matched" });
    }
  }
  return {
    id,
    enabled: workflow.enabled,
    nodes,
    edges,
    settings: {
      maxConcurrent: workflow.maxConcurrent,
      targets: workflow.targets,
      timeoutMinutes: workflow.timeoutMinutes,
      concurrency: workflow.concurrency,
      ...(workflow.use ? { reusable: { use: workflow.use, with: workflow.with } } : {}),
    },
  };
}

/** Alias with the word order used by code that treats a graph as its primary model. */
export const workflowGraphFromRelay = relayWorkflowToGraph;

/**
 * Rebuild a Relay-compatible v2 workflow value from a validated graph. The
 * returned value is intentionally not serialized: the existing config writer
 * remains responsible for preserving surrounding YAML/comments.
 */
export function graphToRelayWorkflow(graph: WorkflowGraph): RelayWorkflowV2 {
  assertValidWorkflowGraph(graph);
  const trigger = graph.nodes.find((node): node is WorkflowTriggerNode => node.kind === "trigger")!;
  const actionNodes = graph.nodes.filter((node): node is WorkflowActionNode => node.kind === "action");
  const reusable = graph.settings?.reusable;
  const jobs: Record<string, RelayWorkflowJobV2> = {};
  for (const node of actionNodes) {
    const incoming = graph.edges.filter((edge): edge is WorkflowEdge & { condition: WorkflowDependencyCondition } => edge.target === node.id && edge.condition !== "matched");
    const needs = incoming.map((edge) => {
      if (edge.relayNeed !== undefined && needsEquivalent(edge.relayNeed, edge.source, edge.condition)) return edge.relayNeed;
      return edge.condition === "succeeded" ? edge.source : { job: edge.source, status: edge.condition };
    });
    jobs[node.id] = {
      use: node.use,
      ...(node.config === undefined ? {} : { with: node.config }),
      ...(needs.length === 0 ? {} : { needs }),
      ...(node.condition ? { if: node.condition } : {}),
      continueOnError: node.continueOnError ?? false,
      enabled: node.enabled ?? true,
      ...(node.strategy ? { strategy: node.strategy } : {}),
      ...(node.timeoutMinutes ? { timeoutMinutes: node.timeoutMinutes } : {}),
    };
  }
  return {
    enabled: graph.enabled,
    on: { source: trigger.use, ...(trigger.config === undefined ? {} : { match: trigger.config }), fire: trigger.fire ?? { policy: "once-per-match" } },
    ...(graph.settings?.maxConcurrent ? { maxConcurrent: graph.settings.maxConcurrent } : {}),
    ...(graph.settings?.targets ? { targets: graph.settings.targets } : {}),
    timeoutMinutes: graph.settings?.timeoutMinutes ?? 1_440,
    ...(graph.settings?.concurrency ? { concurrency: graph.settings.concurrency } : {}),
    ...(reusable ? { use: reusable.use, ...(reusable.with ? { with: reusable.with } : {}) } : { jobs }),
  };
}

export const workflowGraphToRelay = graphToRelayWorkflow;

/** Report authoring errors without tying the graph layer to React Flow or HTTP. */
export function validateWorkflowGraph(graph: WorkflowGraph): WorkflowGraphValidationIssue[] {
  const issues: WorkflowGraphValidationIssue[] = [];
  if (!graph.id) issues.push({ path: "id", message: "workflow id is required" });
  const ids = new Set<string>();
  const byId = new Map<string, WorkflowNode>();
  for (const [index, node] of graph.nodes.entries()) {
    if (!node.id) issues.push({ path: `nodes.${index}.id`, message: "node id is required" });
    else if (ids.has(node.id)) issues.push({ path: `nodes.${index}.id`, message: `duplicate node id '${node.id}'` });
    else { ids.add(node.id); byId.set(node.id, node); }
    if (!node.use) issues.push({ path: `nodes.${index}.use`, message: "node use is required" });
  }
  const triggers = graph.nodes.filter((node) => node.kind === "trigger");
  if (triggers.length !== 1) issues.push({ path: "nodes", message: "a workflow graph must have exactly one trigger" });
  if (!graph.settings?.reusable && graph.nodes.every((node) => node.kind !== "action")) {
    issues.push({ path: "nodes", message: "a non-reusable workflow needs at least one action" });
  }
  if (graph.settings?.reusable && graph.nodes.some((node) => node.kind === "action")) {
    issues.push({ path: "settings.reusable", message: "a reusable workflow cannot also contain action nodes" });
  }
  const edgeIds = new Set<string>();
  const actionEdges = new Map<string, string[]>();
  for (const [index, edge] of graph.edges.entries()) {
    if (edgeIds.has(edge.id)) issues.push({ path: `edges.${index}.id`, message: `duplicate edge id '${edge.id}'` });
    edgeIds.add(edge.id);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source) { issues.push({ path: `edges.${index}.source`, message: `unknown node '${edge.source}'` }); continue; }
    if (!target) { issues.push({ path: `edges.${index}.target`, message: `unknown node '${edge.target}'` }); continue; }
    if (source.kind === "trigger") {
      if (edge.condition !== "matched") issues.push({ path: `edges.${index}.condition`, message: "trigger edges must use 'matched'" });
      if (target.kind !== "action") issues.push({ path: `edges.${index}.target`, message: "a trigger must target an action" });
      continue;
    }
    if (target.kind !== "action") issues.push({ path: `edges.${index}.target`, message: "action dependencies must target an action" });
    if (!statusConditions.has(edge.condition)) issues.push({ path: `edges.${index}.condition`, message: "action edges must use a job status" });
    actionEdges.set(edge.source, [...(actionEdges.get(edge.source) ?? []), edge.target]);
  }
  const visiting = new Set<string>();
  const complete = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (complete.has(id)) return;
    if (visiting.has(id)) { issues.push({ path: "edges", message: `workflow graph contains a cycle: ${[...path.slice(path.indexOf(id)), id].join(" -> ")}` }); return; }
    visiting.add(id);
    for (const target of actionEdges.get(id) ?? []) visit(target, [...path, id]);
    visiting.delete(id);
    complete.add(id);
  };
  for (const node of graph.nodes) if (node.kind === "action") visit(node.id, []);
  return issues;
}

export function assertValidWorkflowGraph(graph: WorkflowGraph): void {
  const issues = validateWorkflowGraph(graph);
  if (issues.length > 0) throw new Error(`Invalid workflow graph: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
}
