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
      getIssue: config.tools?.getIssue ?? "get_issue",
      saveIssue: config.tools?.saveIssue ?? "save_issue",
      saveComment: config.tools?.saveComment ?? "save_comment",
    };
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
