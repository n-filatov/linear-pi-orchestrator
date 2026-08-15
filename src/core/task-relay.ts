import PQueue from "p-queue";

import {
  createRunKey,
  isTerminalWorkItem,
  type AgentLauncher,
  type RelayLogger,
  type RunRecord,
  type RunStore,
  type SourceEvent,
  type TriggerDefinition,
  type WorkItem,
  type WorkSource,
  type WorkspaceProvider,
} from "../domain/index.js";

export interface TriggerProvider {
  list(): Promise<readonly TriggerDefinition[]>;
}

export interface TaskRelayDependencies {
  triggers: TriggerProvider;
  sources: Iterable<WorkSource>;
  runStore: RunStore;
  workspaceProvider: WorkspaceProvider;
  agentLauncher: AgentLauncher;
  logger: RelayLogger;
  now?: () => Date;
}

export interface TickResult {
  triggersVisited: number;
  itemsDiscovered: number;
  runsClaimed: number;
  runsLaunched: number;
  skipped: number;
}

export interface StopOptions {
  /** Also stop currently active workers and ask the workspace provider to clean up. */
  cleanupActive?: boolean;
}

/**
 * Repository-scoped dispatcher. Its only concurrency guarantee is to coalesce
 * overlapping local ticks; RunStore.claim is the cross-process guard.
 */
export class TaskRelay {
  private readonly sources = new Map<string, WorkSource>();
  private readonly now: () => Date;
  private activeTick: Promise<TickResult> | undefined;
  private stopController = new AbortController();

  public constructor(private readonly dependencies: TaskRelayDependencies) {
    for (const source of dependencies.sources) {
      if (this.sources.has(source.id)) {
        throw new Error(`Duplicate work source id: ${source.id}`);
      }
      this.sources.set(source.id, source);
    }
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Returns the in-flight result when a caller invokes tick concurrently. */
  public tick(): Promise<TickResult> {
    if (this.activeTick) return this.activeTick;

    this.activeTick = this.tickInternal().finally(() => {
      this.activeTick = undefined;
    });
    return this.activeTick;
  }

  /** Stops future dispatches. Active workers are only stopped when requested. */
  public async stop(options: StopOptions = {}): Promise<void> {
    this.stopController.abort();
    await this.activeTick;

    if (options.cleanupActive) {
      await this.stopAndCleanupActiveRuns();
    }

    await Promise.all([...this.sources.values()].map(async (source) => source.close?.()));
  }

  private async tickInternal(): Promise<TickResult> {
    const result: TickResult = {
      triggersVisited: 0,
      itemsDiscovered: 0,
      runsClaimed: 0,
      runsLaunched: 0,
      skipped: 0,
    };

    const triggers = await this.dependencies.triggers.list();
    for (const trigger of triggers) {
      if (this.stopController.signal.aborted) break;
      if (!trigger.enabled) continue;
      result.triggersVisited += 1;
      await this.runTrigger(trigger, result);
    }
    return result;
  }

  private async runTrigger(trigger: TriggerDefinition, result: TickResult): Promise<void> {
    const source = this.sources.get(trigger.sourceId);
    if (!source) {
      this.dependencies.logger.error("Configured trigger has no matching work source", {
        triggerId: trigger.id,
        sourceId: trigger.sourceId,
      });
      return;
    }

    let items: readonly WorkItem[];
    try {
      items = await source.discover({ trigger, signal: this.stopController.signal });
    } catch (error) {
      this.dependencies.logger.error("Work source discovery failed", {
        triggerId: trigger.id,
        sourceId: source.id,
        error: messageFor(error),
      });
      return;
    }

    result.itemsDiscovered += items.length;
    const maxConcurrent = normaliseConcurrency(trigger.maxConcurrent);
    const active = await this.dependencies.runStore.countActive({
      repository: trigger.repository,
      sourceId: trigger.sourceId,
      triggerId: trigger.id,
    });
    const remainingCapacity = Math.max(0, maxConcurrent - active);
    if (remainingCapacity === 0) {
      result.skipped += items.length;
      return;
    }

    const eligible: WorkItem[] = [];
    for (const item of items) {
      if (isTerminalWorkItem(item)) {
        result.skipped += 1;
        continue;
      }
      if (item.sourceId !== source.id) {
        this.dependencies.logger.warn("Source returned an item with a mismatched source id", {
          expectedSourceId: source.id,
          itemSourceId: item.sourceId,
          itemId: item.id,
        });
        result.skipped += 1;
        continue;
      }
      const alreadyActive = await this.dependencies.runStore.findActive({
        repository: trigger.repository,
        sourceId: source.id,
        itemId: item.id,
        triggerId: trigger.id,
      });
      if (alreadyActive) {
        result.skipped += 1;
        continue;
      }
      eligible.push(item);
    }

    const queue = new PQueue({ concurrency: remainingCapacity });
    const candidates = eligible.slice(0, remainingCapacity);
    result.skipped += eligible.length - candidates.length;
    for (const item of candidates) {
      void queue.add(async () => {
        const outcome = await this.dispatchItem(source, trigger, item);
        result.runsClaimed += outcome.claimed ? 1 : 0;
        result.runsLaunched += outcome.launched ? 1 : 0;
        result.skipped += outcome.skipped ? 1 : 0;
      }).catch((error: unknown) => {
        this.dependencies.logger.error("Task relay dispatch failed unexpectedly", {
          triggerId: trigger.id,
          sourceId: source.id,
          itemId: item.id,
          error: messageFor(error),
        });
      });
    }
    await queue.onIdle();
  }

  private async dispatchItem(
    source: WorkSource,
    trigger: TriggerDefinition,
    item: WorkItem,
  ): Promise<{ claimed: boolean; launched: boolean; skipped: boolean }> {
    if (this.stopController.signal.aborted || isTerminalWorkItem(item)) {
      return { claimed: false, launched: false, skipped: true };
    }
    if (item.sourceId !== source.id) {
      this.dependencies.logger.warn("Source returned an item with a mismatched source id", {
        expectedSourceId: source.id,
        itemSourceId: item.sourceId,
        itemId: item.id,
      });
      return { claimed: false, launched: false, skipped: true };
    }

    const identity = {
      repository: trigger.repository,
      sourceId: source.id,
      itemId: item.id,
      triggerId: trigger.id,
    };
    if (await this.dependencies.runStore.findActive(identity)) {
      return { claimed: false, launched: false, skipped: true };
    }

    let agent;
    try {
      agent = await this.dependencies.agentLauncher.resolve(trigger.agent, item, trigger);
    } catch (error) {
      this.dependencies.logger.error("Agent resolution failed", {
        triggerId: trigger.id,
        itemId: item.id,
        error: messageFor(error),
      });
      return { claimed: false, launched: false, skipped: true };
    }

    const claimedAt = this.now().toISOString();
    const run = await this.dependencies.runStore.claim({
      id: createRunKey(identity),
      identity,
      item,
      trigger,
      agent,
      claimedAt,
    });
    if (!run) return { claimed: false, launched: false, skipped: true };

    if (!await this.report(source, "claimed", run)) {
      run.status = "failed";
      run.error = "Source rejected or failed to persist the claim.";
      run.completedAt = this.now().toISOString();
      run.updatedAt = run.completedAt;
      await this.dependencies.runStore.update(run);
      return { claimed: true, launched: false, skipped: false };
    }
    try {
      run.status = "provisioning";
      run.updatedAt = this.now().toISOString();
      await this.dependencies.runStore.update(run);
      await this.report(source, "provisioning", run);

      run.workspace = await this.dependencies.workspaceProvider.provision(run, this.stopController.signal);
      run.status = "launching";
      run.updatedAt = this.now().toISOString();
      await this.dependencies.runStore.update(run);

      run.worker = await this.dependencies.agentLauncher.launch({
        run,
        item,
        trigger,
        workspace: run.workspace,
        agent: run.agent,
        signal: this.stopController.signal,
      });
      run.status = "running";
      run.updatedAt = this.now().toISOString();
      await this.dependencies.runStore.update(run);
      await this.report(source, "launched", run);
      this.dependencies.logger.info("Task relay launched work", {
        runId: run.id,
        triggerId: trigger.id,
        sourceId: source.id,
        itemId: item.id,
        agentId: run.agent.agentId,
        model: run.agent.model,
      });
      return { claimed: true, launched: true, skipped: false };
    } catch (error) {
      run.status = "failed";
      run.error = messageFor(error);
      run.completedAt = this.now().toISOString();
      run.updatedAt = run.completedAt;
      await this.dependencies.runStore.update(run);
      await this.report(source, "failed", run, run.error);
      this.dependencies.logger.error("Task relay failed to launch work", {
        runId: run.id,
        error: run.error,
      });
      return { claimed: true, launched: false, skipped: false };
    }
  }

  private async stopAndCleanupActiveRuns(): Promise<void> {
    if (!this.dependencies.runStore.listActive) {
      this.dependencies.logger.warn("Run store cannot enumerate active runs for cleanup");
      return;
    }

    const repositoryIds = new Map<string, TriggerDefinition["repository"]>();
    for (const trigger of await this.dependencies.triggers.list()) {
      repositoryIds.set(trigger.repository.id, trigger.repository);
    }
    for (const repository of repositoryIds.values()) {
      for (const run of await this.dependencies.runStore.listActive(repository)) {
        const source = this.sources.get(run.identity.sourceId);
        try {
          if (run.worker) await this.dependencies.agentLauncher.stop?.(run.worker, run);
          if (run.workspace) await this.dependencies.workspaceProvider.cleanup?.(run.workspace, run);
          run.status = "stopped";
          run.completedAt = this.now().toISOString();
          run.updatedAt = run.completedAt;
          await this.dependencies.runStore.update(run);
          if (source) await this.report(source, "stopped", run);
        } catch (error) {
          this.dependencies.logger.error("Could not stop active run", {
            runId: run.id,
            error: messageFor(error),
          });
        }
      }
    }
  }

  private async report(source: WorkSource, type: SourceEvent["type"], run: RunRecord, error?: string): Promise<boolean> {
    try {
      await source.report({
        type,
        sourceId: source.id,
        run,
        occurredAt: this.now().toISOString(),
        error,
      });
      return true;
    } catch (reportError) {
      // A failed notification must not undo a successfully claimed or launched run.
      this.dependencies.logger.warn("Work source event reporting failed", {
        runId: run.id,
        type,
        error: messageFor(reportError),
      });
      return false;
    }
  }
}

function normaliseConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Trigger maxConcurrent must be a positive integer");
  }
  return value;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
