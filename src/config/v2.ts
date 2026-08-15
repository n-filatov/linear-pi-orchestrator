import { z } from "zod";
import { relayConfigSchema, type RelayConfig as LegacyRelayConfig } from "./schema.js";

const identifier = z.string().min(1).regex(/^[a-zA-Z0-9._:-]+$/, "must contain only letters, numbers, '.', '_', ':' or '-'");
const pluginUse = z.string().min(1).max(512);

/** `with` belongs to the selected plugin and is validated when that plugin is resolved. */
export const pluginDefinitionSchema = z.object({
  use: pluginUse,
  with: z.unknown().optional(),
}).strict();

export const sourceDefinitionV2Schema = pluginDefinitionSchema.extend({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().int().positive().default(30_000),
}).strict();

export const harnessDefinitionV2Schema = pluginDefinitionSchema;

export const actionDefinitionV2Schema = pluginDefinitionSchema.extend({
  /** Disabled reusable actions fail clearly if a trigger tries to use them. */
  enabled: z.boolean().default(true),
}).strict();

export const inlineActionV2Schema = actionDefinitionV2Schema.extend({
  /** Stable key for action output references within this trigger. */
  id: identifier.optional(),
  continueOnError: z.boolean().default(false),
}).strict();

/** A string references `actions.<name>`; object form is an inline action. */
export const triggerActionV2Schema = z.union([identifier, inlineActionV2Schema]);

export const workerTargetSelectorSchema = z.object({
  sourceItem: z.literal("current").default("current"),
  runs: z.enum(["latest", "active", "all"]).default("all"),
  workerIds: z.array(z.string().min(1)).min(1).optional(),
}).strict();

export const triggerTargetsV2Schema = z.object({
  workers: workerTargetSelectorSchema.optional(),
}).strict().optional();

export const firePolicySchema = z.object({
  policy: z.enum(["once-per-match", "once-per-item", "on-change", "every-poll"]).default("once-per-match"),
}).strict().default({});

export const triggerV2Schema = z.object({
  id: identifier,
  source: identifier,
  enabled: z.boolean().default(true),
  /** Opaque to Relay; the selected source plugin validates it. */
  match: z.unknown().default({}),
  actions: z.array(triggerActionV2Schema).min(1),
  targets: triggerTargetsV2Schema,
  fire: firePolicySchema,
  maxConcurrent: z.number().int().min(1).max(32).optional(),
}).strict();

const workspaceSchema = z.object({
  adapter: z.enum(["wt", "git-worktree"]).default("wt"),
  directory: z.string().min(1).default(".task-relay/workspaces"),
  baseBranch: z.string().min(1).default("main"),
  branchPrefix: z.string().min(1).default("relay"),
  branchTemplate: z.string().min(1).optional(),
}).strict().default({});

const executionSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(32).default(2),
  retries: z.number().int().min(0).max(10).default(2),
  adapter: z.enum(["process", "tmux"]).default("process"),
  tmuxSession: z.string().min(1).optional(),
  tmuxWindowName: z.string().min(1).optional(),
}).strict().default({});

const loggingSchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "silent"]).default("info"),
  pretty: z.boolean().default(true),
}).strict().default({});

export const relayConfigV2Schema = z.object({
  version: z.literal(2).default(2),
  project: z.object({ name: z.string().min(1).optional() }).strict().default({}),
  sources: z.record(identifier, sourceDefinitionV2Schema).default({}),
  harnesses: z.record(identifier, harnessDefinitionV2Schema).default({}),
  actions: z.record(identifier, actionDefinitionV2Schema).default({}),
  triggers: z.array(triggerV2Schema).default([]),
  workspace: workspaceSchema,
  execution: executionSchema,
  logging: loggingSchema,
}).strict().superRefine((config, context) => {
  const ids = new Set<string>();
  for (const [index, trigger] of config.triggers.entries()) {
    if (ids.has(trigger.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "id"], message: `duplicate trigger id '${trigger.id}'` });
    ids.add(trigger.id);
    if (!config.sources[trigger.source]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "source"], message: `unknown source '${trigger.source}'` });
    for (const [actionIndex, action] of trigger.actions.entries()) {
      if (typeof action === "string" && !config.actions[action]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggers", index, "actions", actionIndex], message: `unknown action '${action}'` });
    }
  }
});

export type RelayConfigV2 = z.infer<typeof relayConfigV2Schema>;
export type RelayTriggerV2 = z.infer<typeof triggerV2Schema>;
export type RelayActionReference = z.infer<typeof triggerActionV2Schema>;
export type WorkerTargetSelectorConfig = z.infer<typeof workerTargetSelectorSchema>;

/** Parses native v2 configuration, or maps the released v1 shape into v2. */
export function normalizeRelayConfig(input: unknown): RelayConfigV2 {
  if (isRecord(input) && input.version === 2) return relayConfigV2Schema.parse(input);
  return legacyToV2(relayConfigSchema.parse(input));
}

/** Compatibility adapter used by config migration and by consumers moving to the action model. */
export function legacyToV2(legacy: LegacyRelayConfig): RelayConfigV2 {
  const sources: Record<string, z.input<typeof sourceDefinitionV2Schema>> = {};
  for (const [id, source] of Object.entries(legacy.sources)) {
    const { type, enabled, pollIntervalMs, ...withConfig } = source;
    sources[id] = { use: type, enabled, pollIntervalMs, with: withConfig };
  }

  const harnesses: Record<string, z.input<typeof harnessDefinitionV2Schema>> = {};
  for (const [id, agent] of Object.entries(legacy.agents)) {
    harnesses[id] = {
      use: "command",
      with: {
        ...agent,
        promptDelivery: {
          mode: agent.promptDelivery.mode,
          index: agent.promptDelivery.argumentIndex,
          path: agent.promptDelivery.path,
        },
        models: Object.entries(legacy.modelProfiles)
          .filter(([profileId, profile]) => (agent.models.length === 0 || agent.models.includes(profileId)) && (!agent.provider || profile.provider === agent.provider))
          .map(([profileId, profile]) => ({ id: profileId, model: profile.model, args: profile.arguments, reasoningEffort: profile.reasoningEffort })),
      },
    };
  }

  const actions: Record<string, z.input<typeof actionDefinitionV2Schema>> = {};
  const triggers: z.input<typeof triggerV2Schema>[] = legacy.triggers.map((trigger) => {
    const actionId = `legacy.launch.${trigger.id}`;
    const modelProfile = trigger.model ? legacy.modelProfiles[trigger.model] : undefined;
    actions[actionId] = {
      use: "launch",
      with: {
        harness: trigger.agent,
        ...(modelProfile?.model ? { model: modelProfile.model } : {}),
        ...(trigger.model ? { modelProfile: trigger.model } : {}),
        ...(trigger.promptTemplate ? { prompt: trigger.promptTemplate } : {}),
        ...(trigger.workspace ? {
          workspace: {
            ...trigger.workspace,
            ...(trigger.workspace.branchPrefix && !trigger.workspace.branchTemplate
              ? { branchTemplate: `${trigger.workspace.branchPrefix}/{{key}}-{{slug}}` }
              : {}),
          },
        } : {}),
      },
    };
    return {
      id: trigger.id,
      source: trigger.source,
      enabled: trigger.enabled,
      maxConcurrent: trigger.maxConcurrent,
      match: {
        ...trigger.match,
        label: trigger.label,
        ...(trigger.assignee ? { assignee: trigger.assignee } : {}),
      },
      actions: [actionId],
      fire: { policy: "once-per-match" },
    };
  });

  return relayConfigV2Schema.parse({
    version: 2,
    project: legacy.project,
    sources,
    harnesses,
    actions,
    triggers,
    workspace: legacy.workspace,
    execution: legacy.execution,
    logging: legacy.logging,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
