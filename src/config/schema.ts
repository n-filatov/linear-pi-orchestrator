import { z } from "zod";

const identifier = z.string().min(1).regex(/^[a-zA-Z0-9._:-]+$/, "must contain only letters, numbers, '.', '_', ':' or '-'");

const commandInvocationSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  environment: z.record(z.string(), z.string()).default({}),
}).strict();

const mcpTransportSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1).optional(),
    environment: z.record(z.string(), z.string()).default({}),
  }).strict(),
  z.object({
    transport: z.literal("streamable-http"),
    url: z.string().url(),
    /** Header values are read from environment variables, never stored in YAML. */
    headersFromEnvironment: z.record(z.string(), z.string()).default({}),
  }).strict(),
]);

export const sourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("linear"),
    enabled: z.boolean().default(true),
    pollIntervalMs: z.number().int().positive().default(30_000),
    mcp: mcpTransportSchema.optional(),
    tools: z.object({ listIssues: z.string().optional(), saveIssue: z.string().optional(), saveComment: z.string().optional() }).strict().default({}),
    reporting: z.object({ runningLabel: z.string().optional(), blockedLabel: z.string().optional(), doneLabel: z.string().optional(), inProgressState: z.string().optional(), commentOnLaunch: z.boolean().default(true), commentOnFailure: z.boolean().default(true) }).strict().default({}),
  }).strict(),
  z.object({
    type: z.literal("command"),
    enabled: z.boolean().default(true),
    pollIntervalMs: z.number().int().positive().default(30_000),
    discover: commandInvocationSchema,
    report: commandInvocationSchema.optional(),
  }).strict(),
]);

export const agentSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  environment: z.record(z.string(), z.string()).default({}),
  /** Models this launcher accepts; profiles may provide the concrete selection. */
  models: z.array(z.string().min(1)).default([]),
  defaultModel: z.string().min(1).optional(),
  defaultModelProfile: identifier.optional(),
  defaultReasoningEffort: z.string().min(1).optional(),
  modelArgument: z.string().min(1).optional(),
  reasoningEffortArgument: z.string().min(1).optional(),
  promptDelivery: z.object({
    mode: z.enum(["stdin", "argument", "file"]),
    /** Zero-based insertion index when mode is argument; omitted appends the prompt. */
    argumentIndex: z.number().int().min(0).optional(),
    /** Output path when mode is file, relative to the isolated workspace unless absolute. */
    path: z.string().min(1).optional(),
  }).strict().default({ mode: "argument" }),
  availableWhen: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.promptDelivery.mode === "file" && !value.promptDelivery.path) context.addIssue({ code: z.ZodIssueCode.custom, path: ["promptDelivery", "path"], message: "is required when promptDelivery.mode is file" });
});

export const modelProfileSchema = z.object({
  provider: z.string().min(1),
  /** Omit to let the selected agent use its own configured default model. */
  model: z.string().min(1).optional(),
  arguments: z.array(z.string()).default([]),
  reasoningEffort: z.string().min(1).optional(),
}).strict();

export const triggerSchema = z.object({
  id: identifier,
  source: identifier,
  label: z.string().min(1),
  agent: identifier,
  model: identifier.optional(),
  enabled: z.boolean().default(true),
  assignee: z.string().min(1).optional(),
  match: z.record(z.string(), z.unknown()).default({}),
  maxConcurrent: z.number().int().min(1).max(32).optional(),
  promptTemplate: z.string().min(1).optional(),
  workspace: z.object({ branchPrefix: z.string().min(1).optional(), branchTemplate: z.string().min(1).optional(), baseBranch: z.string().min(1).optional() }).strict().optional(),
}).strict();

export const relayConfigSchema = z.object({
  version: z.literal(1).default(1),
  project: z.object({ name: z.string().min(1).optional() }).strict().default({}),
  sources: z.record(identifier, sourceSchema).default({}),
  agents: z.record(identifier, agentSchema).default({}),
  modelProfiles: z.record(identifier, modelProfileSchema).default({}),
  triggers: z.array(triggerSchema).default([]),
  workspace: z.object({
    adapter: z.enum(["wt", "git-worktree"]).default("wt"),
    directory: z.string().min(1).default(".task-relay/workspaces"),
    baseBranch: z.string().min(1).default("main"),
    branchPrefix: z.string().min(1).default("relay"),
    branchTemplate: z.string().min(1).optional(),
  }).strict().default({}),
  execution: z.object({
    maxConcurrent: z.number().int().min(1).max(32).default(2),
    retries: z.number().int().min(0).max(10).default(2),
    adapter: z.enum(["process", "tmux"]).default("process"),
    tmuxSession: z.string().min(1).optional(),
  }).strict().default({}),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "silent"]).default("info"),
    pretty: z.boolean().default(true),
  }).strict().default({}),
}).strict().superRefine((config, context) => {
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (agent.defaultModelProfile && !config.modelProfiles[agent.defaultModelProfile]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", agentId, "defaultModelProfile"], message: `unknown model profile '${agent.defaultModelProfile}'` });
    if (agent.defaultModel && agent.models.length > 0 && !agent.models.includes(agent.defaultModel)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", agentId, "defaultModel"], message: "must be included in agents.<name>.models when models is specified" });
  }
  for (const [index, trigger] of config.triggers.entries()) {
    if (!config.sources[trigger.source]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "source"], message: `unknown source '${trigger.source}'` });
    if (!config.agents[trigger.agent]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "agent"], message: `unknown agent '${trigger.agent}'` });
    if (trigger.model && !config.modelProfiles[trigger.model]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "model"], message: `unknown model profile '${trigger.model}'` });
  }
  const ids = new Set<string>();
  for (const [index, trigger] of config.triggers.entries()) {
    if (ids.has(trigger.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "id"], message: `duplicate trigger id '${trigger.id}'` });
    ids.add(trigger.id);
  }
});

export type RelayConfig = z.infer<typeof relayConfigSchema>;
export type RelayTrigger = z.infer<typeof triggerSchema>;
