import { z } from "zod";
import type { SourcePlugin } from "../plugins/contracts.js";
import { CommandWorkSource, type CommandInvocation, type CommandRunner } from "./command-source.js";
import { LinearMcpSource } from "./linear-mcp-source.js";
import type { McpToolClient } from "./mcp-tool-client.js";

const invocationSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().min(1).optional(), environment: z.record(z.string()).default({}) }).strict();
export const commandSourceConfigSchema = z.object({ discover: invocationSchema, report: invocationSchema.optional() }).strict();
export const linearSourceConfigSchema = z.object({
  mcp: z.unknown(),
  tools: z.object({ listIssues: z.string().optional(), listLabels: z.string().optional(), listTeams: z.string().optional(), listStatuses: z.string().optional(), listUsers: z.string().optional(), getIssue: z.string().optional(), saveIssue: z.string().optional(), saveComment: z.string().optional() }).strict().optional(),
  reporting: z.object({ runningLabel: z.string().optional(), blockedLabel: z.string().optional(), doneLabel: z.string().optional(), inProgressState: z.string().optional(), commentOnLaunch: z.boolean().optional(), commentOnFailure: z.boolean().optional() }).strict().optional(),
}).strict();
export const linearMatchSchema = z.object({ label: z.string().optional(), labels: z.object({ all: z.array(z.string()).optional(), any: z.array(z.string()).optional(), none: z.array(z.string()).optional() }).strict().optional(), statuses: z.array(z.string()).optional(), statusTypes: z.array(z.string()).optional(), assignee: z.string().optional(), limit: z.number().int().positive().optional(), includeArchived: z.boolean().optional(), orderBy: z.string().optional(), excludeLabels: z.array(z.string()).optional() }).strict();

export interface BuiltInSourceDependencies {
  commandRunner?: CommandRunner;
  commandInvocation(value: z.infer<typeof invocationSchema>): CommandInvocation;
  connectLinear(sourceId: string, mcp: unknown): Promise<McpToolClient>;
}

/** Built-ins use the same SourcePlugin registry path as external sources. */
export function builtInSourcePlugins(dependencies: BuiltInSourceDependencies): readonly SourcePlugin[] {
  const linearSources = new Map<string, LinearMcpSource>();
  const command: SourcePlugin<z.infer<typeof commandSourceConfigSchema>, Record<string, never>> = {
    kind: "source", use: "command", configSchema: commandSourceConfigSchema, matchSchema: z.object({}).passthrough(),
    presentation: { name: "Command source", description: "Discover canonical work items from a command.", category: "Sources", icon: "terminal", color: "#475569" },
    discover: ({ sourceId, config, signal, trigger }) => new CommandWorkSource({ id: sourceId, discover: dependencies.commandInvocation(config.discover), report: config.report ? dependencies.commandInvocation(config.report) : undefined }, dependencies.commandRunner).discover({ trigger: trigger ?? { id: sourceId, sourceId, repository: { id: "plugin", root: "" }, enabled: true }, signal }),
  };
  const linear: SourcePlugin<z.infer<typeof linearSourceConfigSchema>, z.infer<typeof linearMatchSchema>> = {
    kind: "source", use: "linear", configSchema: linearSourceConfigSchema, matchSchema: linearMatchSchema,
    presentation: { name: "Linear", description: "Poll Linear work items through an MCP connection.", category: "Sources", icon: "linear", color: "#5e6ad2" },
    async discover(context) {
      let source = linearSources.get(context.sourceId);
      if (!source) { source = new LinearMcpSource({ id: context.sourceId, client: await dependencies.connectLinear(context.sourceId, context.config.mcp), tools: context.config.tools, reporting: context.config.reporting }); linearSources.set(context.sourceId, source); }
      return source.discover({ trigger: { id: context.sourceId, sourceId: context.sourceId, repository: context.repository, enabled: true, selector: context.match }, signal: context.signal });
    },
    matches: (item, match, context) => {
      const source = linearSources.get(context.sourceId);
      return source ? source.matches(item, match) : true;
    },
    async close() { await Promise.all([...linearSources.values()].map((source) => source.close())); linearSources.clear(); },
  };
  return [command, linear];
}
