import type {
  DiscoverWorkOptions,
  SourceEvent,
  WorkItem,
  WorkSource,
} from "../domain/index.js";
import { readMcpJson, type McpToolClient } from "./mcp-tool-client.js";

/** Linear-only selector vocabulary. It deliberately does not leak into the core trigger type. */
export interface LinearTriggerSelector {
  label?: string;
  assignee?: string;
  limit?: number;
  includeArchived?: boolean;
  orderBy?: string;
  excludeLabels?: string[];
}

export interface LinearMcpSourceConfig {
  id: string;
  client: McpToolClient;
  /** Linear MCP tool names are owned by this adapter and can vary by server. */
  tools?: {
    listIssues?: string;
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
      saveIssue: config.tools?.saveIssue ?? "save_issue",
      saveComment: config.tools?.saveComment ?? "save_comment",
    };
  }

  public async discover({ trigger }: DiscoverWorkOptions): Promise<readonly WorkItem[]> {
    const selector = readSelector(trigger.selector);
    const response = await this.config.client.callTool(this.tools.listIssues, {
      label: selector.label,
      assignee: selector.assignee,
      limit: selector.limit ?? 50,
      includeArchived: selector.includeArchived ?? false,
      orderBy: selector.orderBy ?? "updatedAt",
    });
    const issues = readIssues(readMcpJson(response));
    return issues
      .map((issue) => toWorkItem(this.id, issue))
      .filter((item) => !selector.excludeLabels?.some((label) => readStringArray(item.metadata?.linearLabels).includes(label)));
  }

  public async report(event: SourceEvent): Promise<void> {
    const issueId = event.run.item.id;
    if (event.type === "claimed") {
      await this.markRunning(issueId, event.run.item);
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
    if (event.type === "failed") {
      await this.markFailed(issueId, event.run.item);
      if (this.config.reporting?.commentOnFailure) {
        await this.config.client.callTool(this.tools.saveComment, {
          issueId,
          body: `Task Relay failed to launch this work item.\n\n${event.error ?? "Unknown error"}`,
        });
      }
      return;
    }
    if (event.type === "stopped") await this.clearRunning(issueId, event.run.item);
  }

  public async close(): Promise<void> {
    await this.config.client.close?.();
  }

  private async markRunning(issueId: string, item: WorkItem): Promise<void> {
    const reporting = this.config.reporting;
    if (!reporting?.runningLabel && !reporting?.inProgressState) return;
    const oldLabels = readStringArray(item.metadata?.linearLabels);
    const labels = reporting.runningLabel ? [...new Set([...oldLabels, reporting.runningLabel])] : oldLabels;
    const args: Record<string, unknown> = { id: issueId, labels };
    if (reporting.inProgressState) args.state = reporting.inProgressState;
    await this.config.client.callTool(this.tools.saveIssue, args);
  }

  private async markFailed(issueId: string, item: WorkItem): Promise<void> {
    const reporting = this.config.reporting;
    const labels = readStringArray(item.metadata?.linearLabels).filter((label) => label !== reporting?.runningLabel);
    if (reporting?.blockedLabel) labels.push(reporting.blockedLabel);
    await this.config.client.callTool(this.tools.saveIssue, { id: issueId, labels: [...new Set(labels)] });
  }

  private async clearRunning(issueId: string, item: WorkItem): Promise<void> {
    const labels = readStringArray(item.metadata?.linearLabels).filter((label) => label !== this.config.reporting?.runningLabel);
    await this.config.client.callTool(this.tools.saveIssue, { id: issueId, labels: [...new Set(labels)] });
  }
}

function readSelector(value: Record<string, unknown> | undefined): LinearTriggerSelector {
  if (!value) return {};
  return {
    label: readOptionalString(value.label),
    assignee: readOptionalString(value.assignee),
    limit: readOptionalPositiveInteger(value.limit),
    includeArchived: typeof value.includeArchived === "boolean" ? value.includeArchived : undefined,
    orderBy: readOptionalString(value.orderBy),
    excludeLabels: readStringArray(value.excludeLabels),
  };
}

function readIssues(value: unknown): LinearIssue[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.issues)) return value.issues.filter(isRecord);
  throw new Error("Linear list_issues result must be an issue array or { issues: [...] }");
}

function toWorkItem(sourceId: string, issue: LinearIssue): WorkItem {
  const id = readOptionalString(issue.id) ?? readOptionalString(issue.identifier);
  const title = readOptionalString(issue.title);
  if (!id || !title) throw new Error("Linear issue is missing id or title");
  const statusType = readOptionalString(issue.statusType)?.toLowerCase();
  const status = readOptionalString(issue.status)?.toLowerCase();
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
      linearLabels: normaliseLabels(issue.labels),
      linearAssignee: issue.assignee,
    },
  };
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
