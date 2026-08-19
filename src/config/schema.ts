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
    tools: z.object({ listIssues: z.string().optional(), getIssue: z.string().optional(), saveIssue: z.string().optional(), saveComment: z.string().optional() }).strict().default({}),
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
  /** Optional provider guard used to reject incompatible model profiles. */
  provider: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  interactiveArgs: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).default({}),
  /** Model profile ids this launcher accepts; empty means all provider-compatible profiles. */
  models: z.array(z.string().min(1)).default([]),
  /** Optional raw model id used when no model profile is selected. */
  defaultModel: z.string().min(1).optional(),
  defaultModelProfile: identifier.optional(),
  defaultReasoningEffort: z.string().min(1).optional(),
  modelArgument: z.string().min(1).optional(),
  reasoningEffortArgument: z.string().min(1).optional(),
  promptDelivery: z.object({
    mode: z.enum(["stdin", "argument", "file", "interactive"]),
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
    for (const [modelIndex, profileId] of agent.models.entries()) {
      const profile = config.modelProfiles[profileId];
      if (!profile) context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", agentId, "models", modelIndex], message: `unknown model profile '${profileId}'` });
      else if (agent.provider && profile.provider !== agent.provider) context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", agentId, "models", modelIndex], message: `provider '${profile.provider}' is incompatible with agent provider '${agent.provider}'` });
    }
    if (agent.defaultModelProfile) {
      const profile = config.modelProfiles[agent.defaultModelProfile];
      if (!profile) context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", agentId, "defaultModelProfile"], message: `unknown model profile '${agent.defaultModelProfile}'` });
      else {
        if (agent.models.length > 0 && !agent.models.includes(agent.defaultModelProfile)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", agentId, "defaultModelProfile"], message: `model profile '${agent.defaultModelProfile}' is not allowed by this agent` });
        if (agent.provider && profile.provider !== agent.provider) context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", agentId, "defaultModelProfile"], message: `provider '${profile.provider}' is incompatible with agent provider '${agent.provider}'` });
      }
    }
  }
  for (const [index, trigger] of config.triggers.entries()) {
    if (!config.sources[trigger.source]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "source"], message: `unknown source '${trigger.source}'` });
    if (!config.agents[trigger.agent]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "agent"], message: `unknown agent '${trigger.agent}'` });
    if (trigger.model) {
      const profile = config.modelProfiles[trigger.model];
      const agent = config.agents[trigger.agent];
      if (!profile) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "model"], message: `unknown model profile '${trigger.model}'` });
      else if (agent) {
        if (agent.models.length > 0 && !agent.models.includes(trigger.model)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "model"], message: `model profile '${trigger.model}' is not allowed by agent '${trigger.agent}'` });
        if (agent.provider && profile.provider !== agent.provider) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "model"], message: `provider '${profile.provider}' is incompatible with agent '${trigger.agent}' provider '${agent.provider}'` });
      }
    }
  }
  const ids = new Set<string>();
  for (const [index, trigger] of config.triggers.entries()) {
    if (ids.has(trigger.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "id"], message: `duplicate trigger id '${trigger.id}'` });
    ids.add(trigger.id);
  }
});

export type RelayConfig = z.infer<typeof relayConfigSchema>;
export type RelayTrigger = z.infer<typeof triggerSchema>;

// v2 is exported here as well as from `config/v2` so existing consumers have a
// single configuration entry point during the migration.
export {
  actionDefinitionV2Schema,
  firePolicySchema,
  harnessDefinitionV2Schema,
  inlineActionV2Schema,
  legacyToV2,
  normalizeRelayConfig,
  pluginDefinitionSchema,
  relayConfigV2Schema,
  sourceDefinitionV2Schema,
  triggerActionV2Schema,
  triggerTargetsV2Schema,
  triggerV2Schema,
  withUsesAlias,
  workerTargetSelectorSchema,
  workflowJobSchema,
  workflowNeedSchema,
  workflowSchema,
} from "./v2.js";
export type {
  RelayActionReference,
  RelayConfigV2,
  RelayTriggerV2,
  RelayWorkflowJobV2,
  RelayWorkflowNeedV2,
  RelayWorkflowV2,
  WorkerTargetSelectorConfig,
} from "./v2.js";
