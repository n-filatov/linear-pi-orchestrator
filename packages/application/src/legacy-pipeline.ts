import type {
  TriggerActionDefinition,
  TriggerDefinition,
  WorkflowDefinition,
  WorkflowJobDefinition,
} from "@task-relay/domain";

/**
 * Marker written on workflows produced from an ordered trigger pipeline.
 *
 * The workflow engine still owns execution of these jobs.  The marker gives
 * the engine (and inspection tools) enough provenance to retain the old
 * trigger-action invocation identity while the configuration is migrated.
 */
export const LEGACY_PIPELINE_COMPATIBILITY = "legacy-pipeline" as const;

export interface LegacyPipelineCompatibility {
  readonly mode: typeof LEGACY_PIPELINE_COMPATIBILITY;
  readonly version: 1;
  /** The trigger id used by the old action invocation ledger. */
  readonly triggerId: string;
  /** Original trigger policy used by the legacy action ledger. */
  readonly firePolicy: TriggerDefinition["firePolicy"];
  /** Ordered action ids, retained for stable job and output references. */
  readonly actionIds: readonly string[];
  /** Worker generation is part of old worker-target idempotency keys. */
  readonly includeWorkerGeneration: true;
}

/** Metadata extension understood by the unified execution engine. */
export interface LegacyPipelineMetadata extends Record<string, unknown> {
  readonly legacyPipeline: LegacyPipelineCompatibility;
}

/** The expression used to retain legacy continue-on-error traversal. */
export const LEGACY_CONTINUE_CONDITION = "${{ always() }}" as const;

/** Extra condition fields accepted by older callers during normalization. */
export type LegacyPipelineAction = TriggerActionDefinition & {
  /** GitHub-shaped condition used by some pre-workflow configuration writers. */
  if?: string;
};

export type LegacyPipelineTrigger = Omit<TriggerDefinition, "actions"> & {
  actions?: readonly LegacyPipelineAction[];
};

/**
 * Convert an ordered `trigger.actions` pipeline into one workflow definition.
 *
 * A pipeline's order becomes a linear dependency chain.  A normal dependency
 * waits for the preceding action to succeed or skip, matching the old loop.
 * When that preceding action opted into `continueOnError`, `always()` lets the
 * next action run after a handled failure, which is the behavior the legacy
 * dispatcher provided.  The trigger's source, target selector, fire policy,
 * concurrency, repository and metadata remain attached to the workflow so
 * worker-targeted actions and occurrence/idempotency decisions keep the same
 * scope.
 */
export function legacyPipelineToWorkflow(trigger: LegacyPipelineTrigger): WorkflowDefinition {
  const actions = trigger.actions ?? [];
  assertLegacyActions(trigger.id, actions);

  const jobs: WorkflowJobDefinition[] = actions.map((action, index) => {
    const previous = index === 0 ? undefined : actions[index - 1];
    const configuredCondition = action.if;
    const condition = previous?.continueOnError === true
      ? continueCondition(configuredCondition)
      : configuredCondition;
    return {
      id: action.id,
      use: action.use,
      ...(action.config === undefined ? {} : { config: action.config }),
      ...(previous === undefined ? {} : { needs: [{ job: previous.id }] }),
      ...(condition === undefined ? {} : { if: condition }),
      continueOnError: action.continueOnError ?? false,
    };
  });

  const compatibility: LegacyPipelineCompatibility = {
    mode: LEGACY_PIPELINE_COMPATIBILITY,
    version: 1,
    triggerId: trigger.id,
    firePolicy: trigger.firePolicy ?? "once-per-match",
    actionIds: actions.map((action) => action.id),
    includeWorkerGeneration: true,
  };
  const metadata: LegacyPipelineMetadata = {
    ...(trigger.metadata ?? {}),
    legacyPipeline: compatibility,
  };

  return {
    id: trigger.id,
    sourceId: trigger.sourceId,
    repository: trigger.repository,
    enabled: trigger.enabled,
    ...(trigger.selector === undefined ? {} : { selector: trigger.selector }),
    // Legacy ordered actions were evaluated on every poll and relied on the
    // invocation ledger for idempotency. Keep that lifecycle when no explicit
    // fire policy was supplied, including reopened worker generations.
    firePolicy: trigger.firePolicy ?? "every-poll",
    ...(trigger.maxConcurrent === undefined ? {} : { maxConcurrent: trigger.maxConcurrent }),
    ...(trigger.targets === undefined ? {} : { targets: trigger.targets }),
    metadata,
    jobs,
  };
}

/** Descriptive alias for callers that name the source object explicitly. */
export const legacyTriggerToWorkflow = legacyPipelineToWorkflow;

/** Descriptive alias for config/application boundaries that normalize values. */
export const normalizeLegacyPipeline = legacyPipelineToWorkflow;

function assertLegacyActions(triggerId: string, actions: readonly TriggerActionDefinition[]): void {
  if (actions.length === 0) throw new Error(`Trigger '${triggerId}' has no actions to normalize.`);
  const ids = new Set<string>();
  for (const [index, action] of actions.entries()) {
    if (!action.id || action.id.trim().length === 0) throw new Error(`Trigger '${triggerId}' action ${index} must have a non-empty id.`);
    if (ids.has(action.id)) throw new Error(`Trigger '${triggerId}' uses action id '${action.id}' more than once.`);
    ids.add(action.id);
    if (!action.use || action.use.trim().length === 0) throw new Error(`Trigger '${triggerId}' action '${action.id}' must name a plugin.`);
  }
}

function continueCondition(condition: string | undefined): string {
  if (!condition || condition.trim().length === 0) return LEGACY_CONTINUE_CONDITION;
  const wrapped = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition);
  const source = wrapped?.[1]?.trim() ?? condition.trim();
  return `\${{ always() && (${source}) }}`;
}
