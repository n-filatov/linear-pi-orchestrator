import type {
  DiscoverWorkOptions,
  SourceEvent,
  WorkItem,
  WorkSource,
} from "../domain/index.js";
import { readMcpJson, type McpToolClient } from "./mcp-tool-client.js";

/** Linear-only selector vocabulary. It deliberately does not leak into the core trigger type. */
export interface LinearTriggerSelector {
  /** Legacy shorthand for `labels.all: [label]`. */
  label?: string;
  /**
   * Label matching is evaluated by the Linear provider, after any server-side
   * narrowing.  A list issue call can only express one label, while these
   * rules retain the full AND/OR/NOT semantics.
   */
  labels?: {
    all?: string[];
    any?: string[];
    none?: string[];
  };
  /** Issue workflow-state names. `status` is accepted as a legacy alias. */
  statuses?: string[];
  /** Linear workflow-state types, such as `started`, `completed`, or `canceled`. */
  statusTypes?: string[];
  assignee?: string;
  limit?: number;
  includeArchived?: boolean;
  orderBy?: string;
  /** Legacy shorthand for `labels.none`. */
  excludeLabels?: string[];
}

export interface LinearMcpSourceConfig {
  id: string;
  client: McpToolClient;
  /** Linear MCP tool names are owned by this adapter and can vary by server. */
  tools?: {
    listIssues?: string;
    listLabels?: string;
    listTeams?: string;
    listStatuses?: string;
    listUsers?: string;
    getIssue?: string;
    saveIssue?: string;
    saveComment?: string;
  };
  /** Optional Linear lifecycle updates performed when the relay reports events. */
  reporting?: {
    runningLabel?: string;
    blockedLabel?: string;
    doneLabel?: string;
    inProgressState?: string;
    commentOnLaunch?: boolean;
    commentOnFailure?: boolean;
  };
}

/** Values that can be selected in the dashboard trigger editor. */
export interface LinearTriggerOptions {
  labels: string[];
  statuses: Array<{ name: string; type?: string }>;
  users: Array<{ id: string; name: string }>;
}

type LinearIssue = {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  status?: unknown;
  statusType?: unknown;
  labels?: unknown;
  assignee?: unknown;
  [key: string]: unknown;
};

/** Maps Linear MCP's issue objects and lifecycle actions into the canonical source contract. */
export class LinearMcpSource implements WorkSource {
  public readonly id: string;
  private readonly tools: Required<NonNullable<LinearMcpSourceConfig["tools"]>>;

  public constructor(private readonly config: LinearMcpSourceConfig) {
    this.id = config.id;
    this.tools = {
      listIssues: config.tools?.listIssues ?? "list_issues",
      listLabels: config.tools?.listLabels ?? "list_issue_labels",
      listTeams: config.tools?.listTeams ?? "list_teams",
      listStatuses: config.tools?.listStatuses ?? "list_issue_statuses",
      listUsers: config.tools?.listUsers ?? "list_users",
      getIssue: config.tools?.getIssue ?? "get_issue",
      saveIssue: config.tools?.saveIssue ?? "save_issue",
      saveComment: config.tools?.saveComment ?? "save_comment",
    };
  }

  /**
   * Fetches selector vocabulary from the configured Linear MCP server. These
   * values are deliberately fetched on demand: Linear workspaces differ and
   * names can change without a Relay deployment.
   */
  public async triggerOptions(): Promise<LinearTriggerOptions> {
    const [labels, teams, users] = await Promise.all([
      this.listAll(this.tools.listLabels, { limit: 250 }),
      this.listAll(this.tools.listTeams),
      this.listAll(this.tools.listUsers, { limit: 250 }),
    ]);
    const teamOptionsList = teams.flatMap((page) => teamOptions(page));
    const [teamLabelPages, statusResults] = await Promise.all([
      Promise.all(teamOptionsList.map((team) => this.listAll(this.tools.listLabels, { limit: 250, team: team.id }))),
      Promise.all(teamOptionsList.map((team) => this.listAll(this.tools.listStatuses, { team: team.id }))),
    ]);
    return {
      labels: mergeNames([...labels, ...teamLabelPages.flat()].map(optionNames)),
      statuses: mergeStatuses(statusResults.flat().map(optionStatuses)),
      users: mergeUsers(users.map(optionUsers)),
    };
  }

  /** Follows Linear MCP's cursor pagination, with a defensive page cap. */
  private async listAll(tool: string, args: Record<string, unknown> = {}): Promise<unknown[]> {
    const pages: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const value = readMcpJson(await this.config.client.callTool(tool, { ...args, ...(cursor ? { cursor } : {}) }));
      pages.push(value);
      cursor = nextCursor(value);
      if (!cursor) break;
    }
    return pages;
  }

  public async discover({ trigger }: DiscoverWorkOptions): Promise<readonly WorkItem[]> {
    const selector = parseLinearTriggerSelector(trigger.selector);
    const response = await this.config.client.callTool(this.tools.listIssues, {
      ...(listLabel(selector) ? { label: listLabel(selector) } : {}),
      ...(listStatus(selector) ? { state: listStatus(selector) } : {}),
      ...(selector.assignee ? { assignee: selector.assignee } : {}),
      limit: selector.limit ?? 50,
      includeArchived: selector.includeArchived ?? false,
      orderBy: selector.orderBy ?? "updatedAt",
    });
    const issues = readIssues(readMcpJson(response));
    return issues
      .map((issue) => toWorkItem(this.id, issue))
      .filter((item) => this.matches(item, selector));
  }

  /**
   * Provider-owned matching semantics. The generic relay only passes opaque
   * selector data; this adapter owns Linear labels, workflow states, and state
   * types. It is public so action-trigger engines can reuse the exact matching
   * behaviour without reimplementing Linear rules.
   */
  public matches(item: WorkItem, selectorInput: LinearTriggerSelector | Record<string, unknown> | undefined): boolean {
    const selector = parseLinearTriggerSelector(selectorInput);
    const labels = readStringArray(item.metadata?.linearLabels);
    const labelRules = selector.labels;
    const requiredLabels = [selector.label, ...(labelRules?.all ?? [])].filter((label): label is string => Boolean(label));
    const excludedLabels = [...(selector.excludeLabels ?? []), ...(labelRules?.none ?? [])];

    if (!requiredLabels.every((label) => labels.includes(label))) return false;
    if (labelRules?.any && labelRules.any.length > 0 && !labelRules.any.some((label) => labels.includes(label))) return false;
    if (excludedLabels.some((label) => labels.includes(label))) return false;

    const status = readOptionalString(item.metadata?.linearStatus)?.toLowerCase();
    if (selector.statuses && selector.statuses.length > 0 && (!status || !selector.statuses.some((value) => value.toLowerCase() === status))) return false;

    const statusType = readOptionalString(item.metadata?.linearStatusType)?.toLowerCase();
    if (selector.statusTypes && selector.statusTypes.length > 0 && (!statusType || !selector.statusTypes.some((value) => value.toLowerCase() === statusType))) return false;

    return true;
  }

  public async report(event: SourceEvent): Promise<void> {
    const issueId = linearIssueId(event.run.item);
    if (event.type === "claimed") {
      await this.markRunning(issueId);
      return;
    }
    if (event.type === "launched") {
      if (this.config.reporting?.commentOnLaunch) {
        await this.config.client.callTool(this.tools.saveComment, {
          issueId,
          body: `Task Relay launched ${event.run.agent.agentId}${event.run.agent.model ? ` (${event.run.agent.model})` : ""}.`,
        });
      }
      return;
    }
    if (event.type === "succeeded") {
      await this.markSucceeded(issueId);
      return;
    }
    if (event.type === "failed") {
      await this.markFailed(issueId);
      if (this.config.reporting?.commentOnFailure) {
        await this.config.client.callTool(this.tools.saveComment, {
          issueId,
          body: `Task Relay run failed.\n\n${event.error ?? "Unknown error"}`,
        });
      }
      return;
    }
    if (event.type === "stopped") await this.clearRunning(issueId);
  }

  public async close(): Promise<void> {
    await this.config.client.close?.();
  }

  private async markRunning(issueId: string): Promise<void> {
    const reporting = this.config.reporting;
    if (!reporting?.runningLabel && !reporting?.inProgressState) return;
    const args: Record<string, unknown> = { id: issueId };
    if (reporting.runningLabel) {
      const oldLabels = await this.currentLabels(issueId);
      args.labels = [...new Set([...oldLabels, reporting.runningLabel])];
    }
    if (reporting.inProgressState) args.state = reporting.inProgressState;
    await this.config.client.callTool(this.tools.saveIssue, args);
  }

  private async markFailed(issueId: string): Promise<void> {
    const reporting = this.config.reporting;
    if (!reporting?.runningLabel && !reporting?.blockedLabel) return;
    const labels = (await this.currentLabels(issueId)).filter((label) => label !== reporting?.runningLabel);
    if (reporting?.blockedLabel) labels.push(reporting.blockedLabel);
    await this.config.client.callTool(this.tools.saveIssue, { id: issueId, labels: [...new Set(labels)] });
  }

  private async markSucceeded(issueId: string): Promise<void> {
    const reporting = this.config.reporting;
    if (!reporting?.runningLabel && !reporting?.doneLabel) return;
    const labels = (await this.currentLabels(issueId)).filter((label) => label !== reporting?.runningLabel);
    if (reporting?.doneLabel) labels.push(reporting.doneLabel);
    await this.config.client.callTool(this.tools.saveIssue, { id: issueId, labels: [...new Set(labels)] });
  }

  private async clearRunning(issueId: string): Promise<void> {
    if (!this.config.reporting?.runningLabel) return;
    const labels = (await this.currentLabels(issueId)).filter((label) => label !== this.config.reporting?.runningLabel);
    await this.config.client.callTool(this.tools.saveIssue, { id: issueId, labels: [...new Set(labels)] });
  }

  private async currentLabels(issueId: string): Promise<string[]> {
    const response = await this.config.client.callTool(this.tools.getIssue, { id: issueId });
    return normaliseLabels(readIssue(readMcpJson(response)).labels);
  }
}

/**
 * Normalises both the current selector form and legacy selector shorthands.
 * This deliberately does not use the application configuration schema: a
 * Linear plugin must remain usable by other configuration/front-end layers.
 */
export function parseLinearTriggerSelector(value: LinearTriggerSelector | Record<string, unknown> | undefined): LinearTriggerSelector {
  if (!value) return {};
  const raw = value as Record<string, unknown>;
  const labels = readLabelSelector(raw.labels);
  return {
    label: readOptionalString(raw.label),
    labels,
    statuses: readStringList(raw.statuses, raw.status),
    statusTypes: readStringList(raw.statusTypes, raw.statusType),
    assignee: readOptionalString(raw.assignee),
    limit: readOptionalPositiveInteger(raw.limit),
    includeArchived: typeof raw.includeArchived === "boolean" ? raw.includeArchived : undefined,
    orderBy: readOptionalString(raw.orderBy),
    excludeLabels: readStringArray(raw.excludeLabels),
  };
}

/** Returns true when a selector uses a valid Linear selector shape (including legacy aliases). */
export function isLinearTriggerSelector(value: unknown): value is LinearTriggerSelector {
  if (!isRecord(value)) return false;
  if (!isOptionalString(value.label) || !isOptionalString(value.assignee) || !isOptionalString(value.orderBy)) return false;
  if (!isOptionalStringArray(value.excludeLabels) || !isOptionalStringList(value.statuses) || !isOptionalStringList(value.status)
    || !isOptionalStringList(value.statusTypes) || !isOptionalStringList(value.statusType)) return false;
  if (value.limit !== undefined && !readOptionalPositiveInteger(value.limit)) return false;
  if (value.includeArchived !== undefined && typeof value.includeArchived !== "boolean") return false;
  if (value.labels !== undefined) {
    if (!isRecord(value.labels)
      || !isOptionalStringArray(value.labels.all)
      || !isOptionalStringArray(value.labels.any)
      || !isOptionalStringArray(value.labels.none)) return false;
  }
  return true;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0));
}

function isOptionalStringList(value: unknown): boolean {
  return isOptionalString(value) || isOptionalStringArray(value);
}

function readLabelSelector(value: unknown): LinearTriggerSelector["labels"] | undefined {
  if (!isRecord(value)) return undefined;
  const all = readStringArray(value.all);
  const any = readStringArray(value.any);
  const none = readStringArray(value.none);
  if (all.length === 0 && any.length === 0 && none.length === 0) return undefined;
  return {
    ...(all.length > 0 ? { all } : {}),
    ...(any.length > 0 ? { any } : {}),
    ...(none.length > 0 ? { none } : {}),
  };
}

function readStringList(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return [value];
    const entries = readStringArray(value);
    if (entries.length > 0) return entries;
  }
  return undefined;
}

/** A single filter can be sent to Linear without changing the selector meaning. */
function listLabel(selector: LinearTriggerSelector): string | undefined {
  return selector.label
    ?? selector.labels?.all?.[0]
    ?? (selector.labels?.any?.length === 1 ? selector.labels.any[0] : undefined);
}

/** Linear's list_issues calls this workflow-state filter `state`. */
function listStatus(selector: LinearTriggerSelector): string | undefined {
  return selector.statuses?.length === 1 ? selector.statuses[0] : undefined;
}

function readIssues(value: unknown): LinearIssue[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.issues)) return value.issues.filter(isRecord);
  throw new Error("Linear list_issues result must be an issue array or { issues: [...] }");
}

function readIssue(value: unknown): LinearIssue {
  if (isRecord(value) && isRecord(value.issue)) return value.issue;
  if (isRecord(value)) return value;
  throw new Error("Linear get_issue result must be an issue object or { issue: {...} }");
}

function optionRecords(value: unknown, keys: readonly string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key].filter(isRecord);
  // A few MCP servers return `{ data: { nodes: [...] } }` rather than a
  // provider-specific collection name.
  if (isRecord(value.data)) return optionRecords(value.data, [...keys, "nodes"]);
  return [];
}

function optionNames(value: unknown): string[] {
  return [...new Set(optionRecords(value, ["labels", "issueLabels", "data", "nodes"])
    // IDs identify a label internally but are not a valid or useful selector
    // for the dashboard. Some Linear payloads include id-only related records.
    .flatMap((entry) => [readOptionalString(entry.name), readOptionalString(entry.label), readOptionalString(entry.displayName)].filter(Boolean) as string[]))]
    .sort((left, right) => left.localeCompare(right));
}

function mergeNames(values: readonly string[][]): string[] {
  return [...new Set(values.flat())].sort((left, right) => left.localeCompare(right));
}

function nextCursor(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return readOptionalString(value.nextCursor)
    ?? readOptionalString(value.cursor)
    ?? (isRecord(value.pageInfo) ? readOptionalString(value.pageInfo.nextCursor) ?? readOptionalString(value.pageInfo.endCursor) : undefined)
    ?? (isRecord(value.pagination) ? readOptionalString(value.pagination.nextCursor) ?? readOptionalString(value.pagination.cursor) : undefined);
}

function optionStatuses(value: unknown): Array<{ name: string; type?: string }> {
  const deduped = new Map<string, { name: string; type?: string }>();
  for (const entry of optionRecords(value, ["statuses", "issueStatuses", "workflowStates", "data", "nodes"])) {
    const name = readOptionalString(entry.name) ?? readOptionalString(entry.label);
    if (!name) continue;
    const type = readOptionalString(entry.type) ?? readOptionalString(entry.statusType);
    deduped.set(`${name}\u0000${type ?? ""}`, { name, ...(type ? { type } : {}) });
  }
  return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function mergeStatuses(values: ReadonlyArray<Array<{ name: string; type?: string }>>): Array<{ name: string; type?: string }> {
  const deduped = new Map<string, { name: string; type?: string }>();
  for (const status of values.flat()) deduped.set(`${status.name}\u0000${status.type ?? ""}`, status);
  return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function teamOptions(value: unknown): Array<{ id: string }> {
  const deduped = new Map<string, { id: string }>();
  for (const entry of optionRecords(value, ["teams", "data", "nodes"])) {
    const id = readOptionalString(entry.id) ?? readOptionalString(entry.key) ?? readOptionalString(entry.name);
    if (id) deduped.set(id, { id });
  }
  return [...deduped.values()];
}

function optionUsers(value: unknown): Array<{ id: string; name: string }> {
  const deduped = new Map<string, { id: string; name: string }>();
  for (const entry of optionRecords(value, ["users", "members", "data", "nodes"])) {
    const id = readOptionalString(entry.id) ?? readOptionalString(entry.email) ?? readOptionalString(entry.name);
    const name = readOptionalString(entry.name) ?? readOptionalString(entry.displayName) ?? readOptionalString(entry.email) ?? id;
    if (id && name) deduped.set(id, { id, name });
  }
  return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function mergeUsers(values: ReadonlyArray<Array<{ id: string; name: string }>>): Array<{ id: string; name: string }> {
  const deduped = new Map<string, { id: string; name: string }>();
  for (const user of values.flat()) deduped.set(user.id, user);
  return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function toWorkItem(sourceId: string, issue: LinearIssue): WorkItem {
  const id = readOptionalString(issue.identifier) ?? readOptionalString(issue.id);
  const providerId = readOptionalString(issue.id) ?? id;
  const title = readOptionalString(issue.title);
  if (!id || !title) throw new Error("Linear issue is missing id or title");
  const issueStatus = linearStatus(issue);
  const statusType = issueStatus.type?.toLowerCase();
  const status = issueStatus.name?.toLowerCase();
  const terminal = statusType === "completed" || statusType === "canceled" || status === "done" || status === "canceled";
  return {
    sourceId,
    id,
    title,
    description: readOptionalString(issue.description),
    url: readOptionalString(issue.url),
    state: terminal ? "terminal" : "open",
    terminal,
    metadata: {
      linearIssueId: providerId,
      linearIdentifier: id,
      linearLabels: normaliseLabels(issue.labels),
      linearAssignee: issue.assignee,
      linearStatus: issueStatus.name,
      linearStatusType: issueStatus.type,
      // `on-change` trigger policies need Linear's server-side revision so a
      // reopened issue receives a new action generation even when its visible
      // fields return to their previous values.
      linearUpdatedAt: readOptionalString(issue.updatedAt),
    },
  };
}

function linearStatus(issue: LinearIssue): { name?: string; type?: string } {
  const status = isRecord(issue.status) ? issue.status : undefined;
  return {
    name: readOptionalString(issue.status)
      ?? readOptionalString(status?.name)
      ?? readOptionalString(status?.label),
    type: readOptionalString(issue.statusType)
      ?? readOptionalString(status?.type),
  };
}

function linearIssueId(item: WorkItem): string {
  return readOptionalString(item.metadata?.linearIssueId) ?? item.id;
}

function normaliseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    if (typeof label === "string") return [label];
    if (isRecord(label)) {
      const name = readOptionalString(label.name) ?? readOptionalString(label.id);
      return name ? [name] : [];
    }
    return [];
  });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
