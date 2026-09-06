/** Compatibility entry point while callers migrate to @task-relay/application. */
export {
  LEGACY_CONTINUE_CONDITION,
  LEGACY_PIPELINE_COMPATIBILITY,
  legacyPipelineToWorkflow,
  legacyTriggerToWorkflow,
  normalizeLegacyPipeline,
} from "@task-relay/application";
export type {
  LegacyPipelineCompatibility,
  LegacyPipelineAction,
  LegacyPipelineMetadata,
  LegacyPipelineTrigger,
} from "@task-relay/application";
