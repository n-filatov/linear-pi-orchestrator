import type {
  AgentLaunchSpec,
  AgentLauncher,
  AgentProfile,
  AgentResolution,
  RunRecord,
  TriggerDefinition,
  WorkItem,
  WorkerCompletion,
  WorkerHandle,
  WorkerRuntime,
} from "../domain/index.js";
import type { HarnessPlugin } from "../plugins/contracts.js";
import { renderTemplate, templateValues } from "./templates.js";

/** A harness plugin bound to the configuration for one `harnesses:` entry. */
export interface ConfiguredHarnessPlugin {
  id: string;
  plugin: HarnessPlugin;
  config: unknown;
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
 * Routes each launch to whichever launcher owns its harness.
 *
 * Relay ships command harnesses, which the command launcher runs through an
 * execution adapter. An external `HarnessPlugin` manages its own process
 * instead, so it needs its own lifecycle path. Dispatch keys on the resolved
 * agent id, which every run record already carries, so a worker started by one
 * launcher is never waited on or stopped by the other.
 */
export class CompositeAgentLauncher implements AgentLauncher {
  private readonly harnesses: Map<string, ConfiguredHarnessPlugin>;

  constructor(
    private readonly commands: AgentLauncher & { attach?(worker: WorkerHandle): Promise<void>; runtime?: WorkerRuntime },
    plugins: readonly ConfiguredHarnessPlugin[],
  ) {
    this.harnesses = new Map(plugins.map((entry) => [entry.id, entry]));
  }

  /** Only the command launcher owns a terminal Relay can drive. */
  get runtime(): WorkerRuntime | undefined { return this.commands.runtime; }

  ownsPlugin(harnessId: string | undefined): boolean {
    return Boolean(harnessId && this.harnesses.has(harnessId));
  }

  async resolve(profile: AgentProfile | undefined, item: WorkItem, trigger: TriggerDefinition): Promise<AgentResolution> {
    const requested = profile?.id ?? trigger.agent?.id;
    const harness = requested ? this.harnesses.get(requested) : undefined;
    if (!harness) return this.commands.resolve(profile, item, trigger);
    const model = profile?.model ?? trigger.agent?.model;
    return {
      requestedAgentId: requested,
      requestedModel: model,
      agentId: harness.id,
      model,
      metadata: { harnessPlugin: harness.plugin.use },
    };
  }

  async launch(spec: AgentLaunchSpec): Promise<WorkerHandle> {
    const harness = this.harnesses.get(spec.agent.agentId);
    if (!harness) return this.commands.launch(spec);

    const prompt = renderTemplate(
      spec.trigger.agent?.promptTemplate ?? defaultPromptTemplate,
      templateValues({
        workItem: spec.item,
        workspace: spec.workspace,
        repository: spec.run.identity.repository.root,
        model: spec.agent.model,
      }),
    );
    const worker = await harness.plugin.launch({
      workerId: `${spec.item.id}:${harness.id}`,
      repository: spec.run.identity.repository,
      item: spec.item,
      workspace: spec.workspace,
      prompt,
      model: spec.agent.model,
      config: harness.config,
      signal: spec.signal,
    });
    // The harness id is recorded so a restarted relay can route reconcile and
    // stop back to the plugin that started this worker.
    return { ...worker, metadata: { ...worker.metadata, harness: harness.id, harnessPlugin: harness.plugin.use, workspace: spec.workspace.path } };
  }

  async wait(worker: WorkerHandle, run: RunRecord): Promise<WorkerCompletion | undefined> {
    const harness = this.harnessFor(worker, run);
    if (!harness) return this.commands.wait?.(worker, run);
    return harness.plugin.wait?.(worker) ?? undefined;
  }

  async reconcile(worker: WorkerHandle, run: RunRecord): Promise<WorkerCompletion | undefined> {
    const harness = this.harnessFor(worker, run);
    if (!harness) return this.commands.reconcile?.(worker, run);
    if (!harness.plugin.reconcile) {
      // Without reconciliation the plugin cannot say whether its worker survived
      // the restart. Reporting failure is honest; claiming success is not.
      return { status: "failed", error: `Harness '${harness.id}' cannot reconcile a worker after a relay restart.` };
    }
    return harness.plugin.reconcile(worker) ?? undefined;
  }

  async stop(worker: WorkerHandle, run: RunRecord): Promise<void> {
    const harness = this.harnessFor(worker, run);
    if (!harness) { await this.commands.stop?.(worker, run); return; }
    if (!harness.plugin.stop) throw new Error(`Harness '${harness.id}' cannot stop a worker.`);
    await harness.plugin.stop(worker);
  }

  async attach(worker: WorkerHandle): Promise<void> {
    if (typeof worker.metadata?.harness === "string" && this.harnesses.has(worker.metadata.harness)) {
      throw new Error(`Worker ${worker.id} was started by harness plugin '${worker.metadata.harness}', which has no attachable session.`);
    }
    if (!this.commands.attach) throw new Error("The configured execution adapter does not provide attachable workers.");
    await this.commands.attach(worker);
  }

  /** Worker metadata wins over the run record, which may predate a config change. */
  private harnessFor(worker: WorkerHandle, run: RunRecord | undefined): ConfiguredHarnessPlugin | undefined {
    const recorded = typeof worker.metadata?.harness === "string" ? worker.metadata.harness : undefined;
    return this.harnesses.get(recorded ?? run?.agent.agentId ?? "");
  }
}
