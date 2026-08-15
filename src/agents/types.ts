import type { AgentLaunchSpec, AgentProfile, TriggerDefinition, WorkItem, WorkerCompletion, WorkerHandle, Workspace } from "../domain/index.js";

/** The supported ways an agent can receive the rendered task prompt. */
export type PromptDeliveryMode = "stdin" | "argument" | "file";

export type AgentModelProfile = {
  /** Stable configuration key, such as `fast` or `deep`. */
  id: string;
  /** Model identifier passed to templates as `model`. */
  model?: string;
  /** Optional extra argv templates for this model. */
  args?: readonly string[];
  /** Environment templates that apply only to this model. */
  environment?: Readonly<Record<string, string>>;
  reasoningEffort?: string;
};

/**
 * Runtime-ready shape accepted in addition to the domain AgentProfile. The
 * domain type intentionally remains a data contract; this type describes the
 * command-launcher features it supports.
 */
export type CommandAgentProfile = AgentProfile & {
  id: string;
  command: string;
  args?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  models?: readonly AgentModelProfile[];
  defaultModel?: string;
  defaultModelProfile?: string;
  defaultReasoningEffort?: string;
  /** Flag which receives the resolved model as its next argv value. */
  modelArgument?: string;
  /** Flag which receives the resolved reasoning effort as its next argv value. */
  reasoningEffortArgument?: string;
  promptDelivery?: PromptDeliveryMode | {
    mode: PromptDeliveryMode;
    /** Argument position used when mode is `argument`; defaults to append. */
    index?: number;
    /** Path template used when mode is `file`. */
    path?: string;
  };
};

export type AgentLaunchOverrides = {
  agent?: string;
  model?: string;
  modelProfile?: string;
  reasoningEffort?: string;
  promptDelivery?: PromptDeliveryMode;
};

export type AgentCliDefaults = AgentLaunchOverrides & {
  agent?: string;
};

export type ResolvedAgentLaunch = {
  agent: CommandAgentProfile;
  agentId: string;
  modelId?: string;
  modelProfile?: AgentModelProfile;
  modelProfileId?: string;
  reasoningEffort?: string;
  promptDelivery: PromptDeliveryMode;
};

export type AgentLaunchRequest = {
  workItem: WorkItem;
  trigger?: TriggerDefinition;
  workspace: Workspace;
  prompt: string;
  promptFile?: string;
  overrides?: AgentLaunchOverrides;
  cliDefaults?: AgentCliDefaults;
  environment?: Readonly<Record<string, string>>;
};

export type AgentLaunchResult = {
  /** Domain-compatible worker record suitable for persistence. */
  worker: WorkerHandle;
  resolved: ResolvedAgentLaunch;
  command: string;
  args: readonly string[];
  promptFile?: string;
  pid?: number;
  tmux?: { session: string; window: string; index?: string };
};

export type AgentExecution = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin?: string;
  workerName: string;
};

export type AgentExecutionResult = {
  pid?: number;
  tmux?: { session: string; window: string; index?: string; target?: string; exitKey?: string };
};

export interface AgentExecutionAdapter {
  execute(execution: AgentExecution): Promise<AgentExecutionResult>;
  wait?(worker: WorkerHandle): Promise<WorkerCompletion | undefined>;
  reconcile?(worker: WorkerHandle): Promise<WorkerCompletion | undefined>;
  stop?(worker: WorkerHandle): Promise<void>;
}

export type TemplateValues = {
  id: string;
  key: string;
  title: string;
  slug: string;
  description: string;
  url: string;
  source: string;
  repository: string;
  workspace: string;
  branch: string;
  model: string;
  prompt: string;
  promptFile: string;
};

export type AgentLaunchSpecLike = AgentLaunchSpec & Partial<AgentLaunchOverrides>;
