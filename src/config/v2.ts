import { z } from "zod";
import { relayConfigSchema, type RelayConfig as LegacyRelayConfig } from "./schema.js";
import { resolveStringWorkflowNeed } from "../workflows/needs.js";

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

/**
 * A dependency edge. The string form takes GitHub's shape with Argo's status
 * suffix: `implement` waits for success, `implement.Started` waits only for the
 * agent to be running.
 */
export const workflowNeedSchema = z.union([
  z.string().min(1).regex(/^[a-zA-Z0-9._:-]+$/),
  z.object({
    job: identifier,
    status: z.enum(["started", "succeeded", "failed", "skipped"]).optional(),
  }).strict(),
]);

/** One job becomes one instance per combination, all sharing its name as a group. */
export const workflowStrategySchema = z.object({
  matrix: z.record(identifier, z.array(z.union([z.string(), z.number(), z.boolean()])).min(1)),
  maxParallel: z.number().int().min(1).max(32).optional(),
}).strict();

export const workflowJobSchema = z.object({
  use: pluginUse,
  with: z.unknown().optional(),
  needs: z.union([workflowNeedSchema, z.array(workflowNeedSchema)]).optional(),
  /** GitHub Actions expression. Defaults to `success()` when omitted. */
  if: z.string().min(1).optional(),
  continueOnError: z.boolean().default(false),
  enabled: z.boolean().default(true),
  strategy: workflowStrategySchema.optional(),
  /** Fails this job alone, leaving the rest of the run to continue. */
  timeoutMinutes: z.number().int().min(1).max(10_080).optional(),
}).strict();

export const workflowConcurrencySchema = z.object({
  /** Handlebars, rendered per item: `feature-{{item.id}}` is one group per ticket. */
  group: z.string().min(1),
  /** Stop the older run instead of skipping the new one. */
  cancelInProgress: z.boolean().default(false),
}).strict();

/** Inputs a reusable workflow file declares, filled by the `with` that uses it. */
export const workflowInputSchema = z.object({
  description: z.string().optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict();

/** The shape of a standalone, reusable workflow file. */
export const reusableWorkflowFileSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  inputs: z.record(identifier, workflowInputSchema).default({}),
  jobs: z.record(identifier, workflowJobSchema),
}).strict();

export const workflowSchema = z.object({
  enabled: z.boolean().default(true),
  on: z.object({
    source: identifier,
    /** Opaque to Relay; the selected source plugin validates it. */
    match: z.unknown().default({}),
    fire: firePolicySchema,
  }).strict(),
  maxConcurrent: z.number().int().min(1).max(32).optional(),
  targets: triggerTargetsV2Schema,
  /** A run whose jobs can no longer advance is failed rather than left pending. */
  timeoutMinutes: z.number().int().min(1).max(10_080).default(1_440),
  concurrency: workflowConcurrencySchema.optional(),
  /** A reusable workflow file supplying the jobs, instead of declaring them here. */
  use: pluginUse.optional(),
  /** Inputs passed to that file. */
  with: z.record(identifier, z.union([z.string(), z.number(), z.boolean()])).optional(),
  jobs: z.record(identifier, workflowJobSchema).optional(),
}).strict().superRefine((workflow, context) => {
  if (!workflow.use && !workflow.jobs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["jobs"], message: "declare 'jobs', or 'uses' a reusable workflow file" });
    return;
  }
  if (workflow.use && workflow.jobs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["jobs"], message: "a workflow that uses a reusable file cannot also declare jobs" });
    return;
  }
  // A reusable file is validated when it is read, not here: its jobs are not
  // in this document.
  if (!workflow.jobs) return;
  validateJobGraph(workflow.jobs, context, ["jobs"]);
});

/** Shared by inline workflows and reusable files, which have the same job rules. */
export function validateJobGraph(jobs: Record<string, z.infer<typeof workflowJobSchema>>, context: z.RefinementCtx, path: (string | number)[]): void {
  const names = new Set(Object.keys(jobs));
  if (names.size === 0) context.addIssue({ code: z.ZodIssueCode.custom, path, message: "a workflow needs at least one job" });
  for (const [name, job] of Object.entries(jobs)) {
    for (const [index, need] of needList(job.needs).entries()) {
      const resolved = typeof need === "string" ? resolveStringWorkflowNeed(need, names) : { ok: true as const, need: { job: need.job } };
      if (!resolved.ok) {
        const message = resolved.kind === "unknown-job"
          ? `unknown job '${resolved.job}'`
          : `Unknown job status '${resolved.status}' in needs '${need}'. Use Started, Succeeded, Failed, or Skipped.`;
        context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, name, "needs", index], message });
        continue;
      }
      const target = resolved.need.job;
      if (target === name) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, name, "needs", index], message: `job '${name}' cannot need itself` });
      else if (!names.has(target)) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, name, "needs", index], message: `unknown job '${target}'` });
    }
  }
  for (const cycle of dependencyCycles(jobs)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: `needs form a cycle: ${cycle.join(" -> ")}` });
  }
}

function needList(needs: z.infer<typeof workflowJobSchema>["needs"]): readonly z.infer<typeof workflowNeedSchema>[] {
  if (needs === undefined) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/** A cycle can never be satisfied, so it is a configuration error, not a stall. */
function dependencyCycles(jobs: Record<string, z.infer<typeof workflowJobSchema>>): string[][] {
  const names = new Set(Object.keys(jobs));
  const edges = new Map<string, string[]>();
  for (const [name, job] of Object.entries(jobs)) {
    edges.set(name, needList(job.needs).flatMap((need) => {
      if (typeof need !== "string") return [need.job];
      const resolved = resolveStringWorkflowNeed(need, names);
      return resolved.ok ? [resolved.need.job] : [];
    }));
  }
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const walk = (name: string, path: string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      cycles.push([...path.slice(path.indexOf(name)), name]);
      return;
    }
    state.set(name, "visiting");
    for (const next of edges.get(name) ?? []) if (edges.has(next)) walk(next, [...path, name]);
    state.set(name, "done");
  };
  for (const name of edges.keys()) walk(name, []);
  return cycles;
}

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
  /**
   * One live worker per source item. Triggers and workflow jobs compose their
   * own ids into the run key, so the per-run guard cannot see a worker another
   * trigger or job launched for the same ticket. Set false to allow a workflow
   * to run several workers on one ticket at the same time.
   */
  oneWorkerPerItem: z.boolean().default(true),
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
  /** Named, ordered job graphs. Sugar over triggers plus a durable run record. */
  workflows: z.record(identifier, workflowSchema).default({}),
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
  for (const [name, workflow] of Object.entries(config.workflows)) {
    // Triggers and workflows share one id space: both are addressed by
    // `relay once --trigger <id>` and both appear in the tick table.
    if (ids.has(name)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", name], message: `'${name}' is already used by a trigger` });
    ids.add(name);
    if (!config.sources[workflow.on.source]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", name, "on", "source"], message: `unknown source '${workflow.on.source}'` });
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      // A named action is reusable across workflows; anything else is a plugin.
      if (config.actions[job.use] && !config.actions[job.use].enabled) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows", name, "jobs", jobName, "use"], message: `action '${job.use}' is disabled` });
      }
    }
  }
});

export type RelayConfigV2 = z.infer<typeof relayConfigV2Schema>;
export type RelayTriggerV2 = z.infer<typeof triggerV2Schema>;
export type RelayWorkflowV2 = z.infer<typeof workflowSchema>;
export type RelayWorkflowJobV2 = z.infer<typeof workflowJobSchema>;
export type RelayWorkflowNeedV2 = z.infer<typeof workflowNeedSchema>;
export type ReusableWorkflowFile = z.infer<typeof reusableWorkflowFileSchema>;
export type RelayActionReference = z.infer<typeof triggerActionV2Schema>;
export type WorkerTargetSelectorConfig = z.infer<typeof workerTargetSelectorSchema>;

/** Parses native v2 configuration, or maps the released v1 shape into v2. */
export function normalizeRelayConfig(input: unknown): RelayConfigV2 {
  if (isRecord(input) && input.version === 2) return relayConfigV2Schema.parse(withUsesAlias(input));
  return legacyToV2(relayConfigSchema.parse(input));
}

/**
 * `uses` is accepted everywhere `use` is, because that is the word GitHub
 * Actions users already know. One key is normalized to the other before
 * validation so every schema below stays single-keyed and strict.
 */
export function withUsesAlias(document: Record<string, unknown>): Record<string, unknown> {
  const rename = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rename);
    if (!isRecord(value)) return value;
    const mapped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // `with` belongs to a plugin, which may legitimately have its own `uses`.
      if (key === "with") { mapped[key] = entry; continue; }
      mapped[key === "uses" ? "use" : key] = rename(entry);
    }
    if ("use" in mapped && "uses" in value && "use" in value) {
      throw new Error("Use either 'use' or 'uses', not both.");
    }
    return mapped;
  };
  return rename(document) as Record<string, unknown>;
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
