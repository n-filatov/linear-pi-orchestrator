/**
 * The public Task Relay extension ABI.
 *
 * Plugin packages import from `task-relay/plugin`, never from `task-relay`
 * itself. This entry point deliberately exposes only the plugin contracts and
 * the domain types those contracts reference. It pulls in no dashboard, daemon,
 * state store, or CLI code, so a plugin author's `tsc` never has to resolve
 * Relay's own runtime dependencies.
 *
 * Everything exported here is covered by Relay's semantic versioning promise:
 * a breaking change to these types requires a major release.
 */
export type {
  ActionContext,
  ActionPlugin,
  ActionResult,
  HarnessLaunchRequest,
  HarnessPlugin,
  LaunchWorkerActionRequest,
  MaybePromise,
  PluginUse,
  RelayPlugin,
  ResolvedWorker,
  SourcePlugin,
  SourcePluginContext,
  WorkerActions,
  WorkerRef,
  WorkerTargetSelector,
} from "./plugins/contracts.js";

export { RelayPluginRegistry } from "./plugins/contracts.js";

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
