import PQueue from "p-queue";
import type { TriggerDefinition, WorkflowDefinition } from "@task-relay/domain";

export interface PollResultBase {
  triggersVisited: number; itemsDiscovered: number; runsClaimed: number; runsLaunched: number;
  skipped: number; actionsExecuted: number; actionsFailed: number; items: unknown[];
}
export interface PollTriggersOperations<TResult extends PollResultBase> {
  readonly stopSignal: AbortSignal;
  readonly logger: { error(message: string, fields?: Record<string, unknown>): void };
  markExpiredAttempts(): Promise<void>;
  listTriggers(): Promise<readonly TriggerDefinition[]>;
  listWorkflows(): Promise<readonly WorkflowDefinition[]>;
  reconcilePersistedRuns(bindings: readonly TriggerDefinition[]): Promise<void>;
  runTrigger(trigger: TriggerDefinition, result: TResult): Promise<void>;
  runWorkflow(workflow: WorkflowDefinition, result: TResult): Promise<void>;
  createResult(): TResult;
}

/** Coordinates one bounded application poll while decisions stay in the host. */
export class PollTriggers<TResult extends PollResultBase> {
  public constructor(private readonly operations: PollTriggersOperations<TResult>) {}
  public async execute(): Promise<TResult> {
    const result = this.operations.createResult();
    await this.operations.markExpiredAttempts();
    const triggers = await this.operations.listTriggers();
    const workflows = await this.operations.listWorkflows();
    await this.operations.reconcilePersistedRuns([...triggers, ...workflows.map(workflowAsTrigger)]);
    const queue = new PQueue({ concurrency: 8 });
    const tasks = [
      ...triggers.filter((trigger) => trigger.enabled).map((trigger) => () => this.operations.runTrigger(trigger, result)),
      ...workflows.filter((workflow) => workflow.enabled).map((workflow) => () => this.operations.runWorkflow(workflow, result)),
    ];
    await Promise.all(tasks.map((task) => queue.add(async () => {
      if (this.operations.stopSignal.aborted) return;
      result.triggersVisited += 1;
      await task();
    }).catch((error: unknown) => this.operations.logger.error("Relay binding failed", { error: messageFor(error) }))));
    return result;
  }
}
function workflowAsTrigger(workflow: WorkflowDefinition): TriggerDefinition {
  return { id: workflow.id, sourceId: workflow.sourceId, repository: workflow.repository, enabled: workflow.enabled,
    selector: workflow.selector, maxConcurrent: workflow.maxConcurrent, targets: workflow.targets,
    firePolicy: workflow.firePolicy, metadata: workflow.metadata };
}
function messageFor(error: unknown): string { return error instanceof Error ? error.message : String(error); }
