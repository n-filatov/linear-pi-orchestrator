import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentLaunchSpec as DomainAgentLaunchSpec,
  AgentLauncher as DomainAgentLauncher,
  AgentProfile,
  AgentResolution,
  RunRecord,
  TriggerDefinition,
  WorkItem,
  WorkerCompletion,
  WorkerHandle,
  Workspace,
} from "../domain/index.js";
import { renderEnvironment, renderTemplate, renderTemplates, templateValues } from "./templates.js";
import type {
  AgentCliDefaults,
  AgentExecutionAdapter,
  AgentLaunchOverrides,
  AgentLaunchRequest,
  AgentLaunchResult,
  AgentModelProfile,
  BuiltInHarnessId,
  CommandAgentProfile,
  PromptDeliveryMode,
  ResolvedAgentLaunch,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? value as UnknownRecord : {};
}

function stringField(value: unknown, ...names: string[]): string | undefined {
  const source = asRecord(value);
  for (const name of names) {
    const candidate = source[name];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function promptDelivery(profile: CommandAgentProfile, override?: PromptDeliveryMode): { mode: PromptDeliveryMode; path?: string; index?: number } {
  if (override) return { mode: override };
  const configured = profile.promptDelivery;
  if (typeof configured === "string") return { mode: configured };
  return configured ?? { mode: "stdin" };
}

function triggerOverrides(trigger?: TriggerDefinition): AgentLaunchOverrides {
  const agent = trigger?.agent;
  const metadata = asRecord(agent?.metadata);
  return {
    agent: agent?.id,
    model: agent?.model,
    modelProfile: stringField(metadata, "modelProfile", "modelProfileId"),
    reasoningEffort: stringField(metadata, "reasoningEffort", "effort"),
    promptDelivery: trigger?.promptDelivery ?? stringField(metadata, "promptDelivery") as PromptDeliveryMode | undefined,
  };
}

function first<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined && value !== "");
}

/** Deterministically apply run > trigger > agent > CLI-default precedence. */
export function resolveAgentLaunch(input: {
  profiles?: readonly CommandAgentProfile[];
  trigger?: TriggerDefinition;
  overrides?: AgentLaunchOverrides;
  cliDefaults?: AgentCliDefaults;
}): ResolvedAgentLaunch {
  const trigger = triggerOverrides(input.trigger);
  const requestedAgent = first(input.overrides?.agent, trigger.agent, input.cliDefaults?.agent);
  const profiles = input.profiles ?? [];
  const agent = profiles.find((profile) => profile.id === requestedAgent)
    ?? (requestedAgent ? undefined : profiles[0]);
  if (!agent) throw new Error(`Unknown agent profile: ${requestedAgent ?? "(none configured)"}`);

  const explicitModel = input.overrides?.model;
  const requestedModel = first(explicitModel, trigger.model, agent.defaultModel, input.cliDefaults?.model);
  const modelProfileId = first(
    input.overrides?.modelProfile,
    trigger.modelProfile,
    requestedModel && agent.models?.some((profile) => profile.id === requestedModel) ? requestedModel : undefined,
    agent.defaultModelProfile,
    input.cliDefaults?.modelProfile,
  );
  const modelProfile = modelProfileId ? agent.models?.find((profile) => profile.id === modelProfileId) : undefined;
  if (modelProfileId && !modelProfile) throw new Error(`Unknown model profile "${modelProfileId}" for agent "${agent.id}".`);

  const modelId = first(
    explicitModel,
    modelProfile?.model,
    requestedModel && requestedModel !== modelProfileId ? requestedModel : undefined,
  );
  const reasoningEffort = first(
    input.overrides?.reasoningEffort,
    trigger.reasoningEffort,
    modelProfile?.reasoningEffort,
    agent.defaultReasoningEffort,
    input.cliDefaults?.reasoningEffort,
  );
  const delivery = promptDelivery(agent, first(input.overrides?.promptDelivery, trigger.promptDelivery));

  return { agent, agentId: agent.id, modelId, modelProfile, modelProfileId, reasoningEffort, promptDelivery: delivery.mode };
}

export type CommandAgentLauncherOptions = {
  /** Omit to use Relay's built-in command harness profiles. */
  profiles?: readonly CommandAgentProfile[];
  executor: AgentExecutionAdapter;
  /** Defaults supplied by the entry point's parsed CLI/config layer. */
  cliDefaults?: AgentCliDefaults;
  environment?: Readonly<Record<string, string | undefined>>;
  promptFileName?: string;
  /** Handlebars template for the tmux window name. Available: {{item.id}}, {{item.title}}, {{slug}}, etc. */
  windowNameTemplate?: string;
};

/** Launches configured command agents without ever constructing a shell command. */
export class CommandAgentLauncher implements DomainAgentLauncher {
  constructor(private readonly options: CommandAgentLauncherOptions) {}

  async resolve(profile: AgentProfile | undefined, _item: WorkItem, trigger: TriggerDefinition): Promise<AgentResolution> {
    const launch = this.resolveLaunch(agentProfileOverrides(profile), trigger);
    return {
      requestedAgentId: profile?.id ?? trigger.agent?.id,
      requestedModel: profile?.model ?? trigger.agent?.model,
      agentId: launch.agentId,
      model: launch.modelId,
      metadata: {
        modelProfile: launch.modelProfileId,
        reasoningEffort: launch.reasoningEffort,
        promptDelivery: launch.promptDelivery,
      },
    };
  }

  resolveLaunch(overrides?: AgentLaunchOverrides, trigger?: TriggerDefinition): ResolvedAgentLaunch {
    return resolveAgentLaunch({ profiles: this.options.profiles?.length ? this.options.profiles : builtInAgentProfiles(), trigger, overrides, cliDefaults: this.options.cliDefaults });
  }

  async launch(spec: DomainAgentLaunchSpec): Promise<WorkerHandle> {
    const metadata = asRecord(spec.agent.metadata);
    const promptTemplate = spec.trigger.agent?.promptTemplate
      ?? stringField(metadata, "promptTemplate")
      ?? defaultPromptTemplate;
    const values = templateValues({
      workItem: spec.item,
      workspace: spec.workspace,
      repository: spec.run.identity.repository.root,
      model: spec.agent.model,
    });
    const detailed = await this.launchConfigured({
      workItem: spec.item,
      trigger: spec.trigger,
      workspace: spec.workspace,
      prompt: renderTemplate(promptTemplate, values),
      overrides: {
        agent: spec.agent.agentId,
        model: spec.agent.model,
        modelProfile: stringField(metadata, "modelProfile"),
        reasoningEffort: stringField(metadata, "reasoningEffort"),
        promptDelivery: stringField(metadata, "promptDelivery") as PromptDeliveryMode | undefined,
      },
      cliDefaults: this.options.cliDefaults,
    });
    return detailed.worker;
  }

  async stop(worker: WorkerHandle): Promise<void> {
    if (!this.options.executor.stop) throw new Error("The configured execution adapter cannot stop workers.");
    await this.options.executor.stop(worker);
  }

  async attach(worker: WorkerHandle): Promise<void> {
    if (!this.options.executor.attach) throw new Error("The configured execution adapter does not provide attachable workers.");
    await this.options.executor.attach(worker);
  }

  async wait(worker: WorkerHandle, _run: RunRecord): Promise<WorkerCompletion | undefined> {
    return this.options.executor.wait?.(worker);
  }

  async reconcile(worker: WorkerHandle, _run: RunRecord): Promise<WorkerCompletion | undefined> {
    return this.options.executor.reconcile?.(worker);
  }

  async launchConfigured(request: AgentLaunchRequest): Promise<AgentLaunchResult> {
    const resolved = this.resolveLaunch(request.overrides, request.trigger);
    const delivery = promptDelivery(resolved.agent, request.overrides?.promptDelivery ?? triggerOverrides(request.trigger).promptDelivery);
    const workspacePath = workspaceDirectory(request.workspace);
    let promptFile = request.promptFile;

    if (delivery.mode === "file") {
      const preliminary = templateValues({ workItem: request.workItem, workspace: request.workspace, model: resolved.modelId, prompt: request.prompt });
      promptFile ??= path.resolve(workspacePath, renderTemplate(delivery.path ?? this.options.promptFileName ?? ".task-relay-prompt.md", preliminary));
      await mkdir(path.dirname(promptFile), { recursive: true });
      await writeFile(promptFile, request.prompt, "utf8");
    }

    const values = templateValues({
      workItem: request.workItem,
      workspace: request.workspace,
      model: resolved.modelId,
      prompt: request.prompt,
      promptFile,
    });
    const profileArgs = delivery.mode === "interactive"
      ? resolved.agent.interactiveArgs ?? resolved.agent.args
      : resolved.agent.args;
    const args = [...renderTemplates(profileArgs, values), ...renderTemplates(resolved.modelProfile?.args, values)];
    if (resolved.reasoningEffort && resolved.agent.reasoningEffortArgument) args.unshift(renderTemplate(resolved.agent.reasoningEffortArgument, values), resolved.reasoningEffort);
    if (resolved.modelId && resolved.agent.modelArgument) args.unshift(renderTemplate(resolved.agent.modelArgument, values), resolved.modelId);
    if (delivery.mode === "argument") {
      const index = delivery.index ?? args.length;
      args.splice(index, 0, request.prompt);
    }

    const environment = {
      ...this.options.environment,
      ...renderEnvironment(resolved.agent.environment, values),
      ...renderEnvironment(resolved.modelProfile?.environment, values),
      ...request.environment,
      ...(resolved.modelId ? { TASK_RELAY_MODEL: resolved.modelId } : {}),
      ...(resolved.reasoningEffort ? { TASK_RELAY_REASONING_EFFORT: resolved.reasoningEffort } : {}),
    };
    const result = await this.options.executor.execute({
      command: renderTemplate(resolved.agent.command, values),
      args,
      cwd: workspacePath,
      env: environment,
      stdin: delivery.mode === "stdin" ? request.prompt : undefined,
      interactiveInput: delivery.mode === "interactive" ? request.prompt : undefined,
      workerName: renderTemplate(
        this.options.windowNameTemplate ?? "{{item.id}} {{item.title}}",
        templateValues({ workItem: request.workItem, workspace: request.workspace }),
      ),
    });

    return {
      worker: workerHandle(request.workItem, request.workspace, resolved, result),
      resolved,
      command: renderTemplate(resolved.agent.command, values),
      args,
      promptFile,
      ...result,
    };
  }
}

function agentProfileOverrides(profile: AgentProfile | undefined): AgentLaunchOverrides {
  const metadata = asRecord(profile?.metadata);
  return {
    agent: profile?.id,
    model: profile?.model,
    modelProfile: stringField(metadata, "modelProfile", "modelProfileId"),
    reasoningEffort: stringField(metadata, "reasoningEffort", "effort"),
    promptDelivery: stringField(metadata, "promptDelivery") as PromptDeliveryMode | undefined,
  };
}

const defaultPromptTemplate = `You are implementing work item {{key}}.

Title:
{{title}}

Description:
{{description}}

URL: {{url}}
Repository: {{repository}}
Workspace: {{workspace}}
Branch: {{branch}}
`;

/**
 * Built-in command harness definitions. Models stay deliberately unconstrained
 * strings: each harness/provider evolves its own model catalogue, and callers
 * can pass a model directly without adding a Relay release.
 *
 * Callers may replace these profiles entirely or add arbitrary command-based
 * profiles alongside them.
 */
export function builtInAgentProfiles(): readonly CommandAgentProfile[] {
  return [
    {
      id: "codex",
      command: "codex",
      args: ["exec"],
      interactiveArgs: [],
      modelArgument: "--model",
      promptDelivery: "argument",
    },
    {
      id: "claude",
      command: "claude",
      args: ["-p"],
      interactiveArgs: [],
      modelArgument: "--model",
      reasoningEffortArgument: "--effort",
      promptDelivery: "argument",
    },
    {
      id: "pi",
      command: "pi",
      interactiveArgs: [],
      modelArgument: "--model",
      promptDelivery: "argument",
    },
    {
      id: "opencode",
      command: "opencode",
      args: ["run"],
      interactiveArgs: [],
      modelArgument: "--model",
      promptDelivery: "argument",
    },
  ];
}

/** Alias that uses the product vocabulary while retaining the v1 agent API. */
export const builtInHarnessProfiles = builtInAgentProfiles;

/** Resolve one shipped harness definition without exposing a mutable shared object. */
export function builtInHarnessProfile(id: BuiltInHarnessId): CommandAgentProfile {
  const profile = builtInAgentProfiles().find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown built-in harness: ${id}`);
  return profile;
}

function workspaceDirectory(workspace: Workspace): string {
  const candidate = stringField(workspace, "path", "worktree", "directory");
  if (!candidate) throw new Error("Workspace has no path.");
  return candidate;
}

function itemKey(item: WorkItem): string {
  return stringField(item, "key", "identifier", "id") ?? "task-relay-worker";
}

function workerHandle(
  item: WorkItem,
  workspace: Workspace,
  resolved: ResolvedAgentLaunch,
  execution: { pid?: number; tmux?: { session: string; window: string; index?: string; target?: string; exitKey?: string } },
): WorkerHandle {
  return {
    id: `${itemKey(item)}:${resolved.agentId}`,
    startedAt: new Date().toISOString(),
    metadata: {
      workspace: workspace.path,
      agent: resolved.agentId,
      model: resolved.modelId,
      modelProfile: resolved.modelProfileId,
      reasoningEffort: resolved.reasoningEffort,
      pid: execution.pid,
      tmux: execution.tmux,
      persistent: execution.tmux !== undefined,
      interactive: resolved.promptDelivery === "interactive",
    },
  };
}

// Keeps the domain import visible at this module boundary while allowing the
// domain package to refine AgentProfile independently.
export type { AgentProfile };
