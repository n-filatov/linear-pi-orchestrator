/**
 * The public Task Relay extension ABI.
 *
 * Plugin packages import from `task-relay/plugin`, never from `task-relay`
 * itself. This entry point exposes the plugin contracts and the domain types
 * those contracts reference. It does not expose dashboard, daemon, state-store,
 * or CLI APIs. `RelayPluginRegistry` remains as a deprecated compatibility
 * export while external plugins migrate to the SDK contracts.
 *
 * Everything exported here is covered by Relay's semantic versioning promise:
 * a breaking change to these types requires a major release.
 */
export type {
  ActionContext,
  ActionPlugin,
  ActionResult,
  AnyActionPlugin,
  ExplicitActionOutcome,
  HarnessLaunchRequest,
  HarnessPlugin,
  LaunchWorkerActionRequest,
  MaybePromise,
  PluginPresentation,
  PluginJson,
  PluginJsonObject,
  PluginSdkApiVersion,
  PluginUse,
  RelayPlugin,
  ResolvedWorker,
  SourcePlugin,
  SourcePluginContext,
  TriggerPlugin,
  VersionedActionPlugin,
  WorkerActions,
  WorkerRef,
  WorkerTargetSelector,
} from "./plugins/contracts.js";

export { PLUGIN_SDK_API_VERSION, assertPluginJson, isVersionedActionPlugin, validatePluginContract } from "./plugins/contracts.js";
/**
 * @deprecated Import registry and loading utilities from `@task-relay/plugin-host`
 * inside workspace code. Kept here for external plugin compatibility during the
 * package extraction.
 */
export { RelayPluginRegistry } from "@task-relay/plugin-host";
export type {
  AgentResolution,
  RepositoryScope,
  RunIdentity,
  RunRecord,
  RunStatus,
  SourceEvent,
  SourceEventType,
  TriggerDefinition,
  WorkItem,
  WorkItemState,
  WorkerChildHandle,
  WorkerChildSpec,
  WorkerCompletion,
  WorkerHandle,
  WorkerInputSpec,
  WorkerOpenTarget,
  WorkerRuntime,
  WorkerRuntimeCapabilities,
  WorkflowDefinition,
  WorkflowJobDefinition,
  WorkflowJobState,
  WorkflowJobStatus,
  WorkflowNeed,
  WorkflowRunRecord,
  Workspace,
} from "./domain/types.js";

export { isActiveRun, isTerminalJobStatus, isTerminalWorkItem, workerChildren } from "./domain/types.js";
