import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { RelayCommandContext, RelayCommandHandlers } from "../cli/program.js";
import { RepositoryDaemon } from "../daemon.js";
import { stateDirectory } from "../logging/events.js";

export interface SupervisedProject {
  id: string;
  root: string;
  enabled: boolean;
}

export interface RuntimeProjectProvider {
  listProjects(): Promise<readonly SupervisedProject[]>;
  context(projectId: string): Promise<RelayCommandContext>;
}

export interface SupervisedRuntimeStatus {
  projectId: string;
  state: "stopped" | "running" | "blocked" | "failed";
  lastTickAt?: string;
  nextTickAt?: string;
  error?: string;
}

type Controller = {
  project: SupervisedProject;
  timer?: ReturnType<typeof setTimeout>;
  releaseLease?: () => Promise<void>;
  stopped: boolean;
  ticking?: Promise<void>;
  status: SupervisedRuntimeStatus;
};

/**
 * Optional global owner for repository polling. Repository daemons remain
 * supported, but a lease prevents the two modes from supervising one folder at
 * the same time.
 */
export class GlobalRuntimeSupervisor {
  private readonly controllers = new Map<string, Controller>();

  constructor(
    private readonly projects: RuntimeProjectProvider,
    private readonly handlers: RelayCommandHandlers,
  ) {}

  async startAll(): Promise<void> {
    for (const project of await this.projects.listProjects()) {
      if (project.enabled) await this.start(project.id);
    }
  }

  async start(projectId: string): Promise<SupervisedRuntimeStatus> {
    const existing = this.controllers.get(projectId);
    if (existing && !existing.stopped) return existing.status;
    if (!this.handlers.once) throw new Error("The runtime supervisor requires the Relay once handler.");

    const project = (await this.projects.listProjects()).find((entry) => entry.id === projectId);
    if (!project) throw new Error(`Unknown project folder '${projectId}'.`);
    const daemonStatus = await new RepositoryDaemon(project.root).status();
    if (daemonStatus.includes("is running")) {
      const status: SupervisedRuntimeStatus = {
        projectId,
        state: "blocked",
        error: "The repository daemon already owns polling for this folder. Stop it before enabling global supervision.",
      };
      this.controllers.set(projectId, { project, stopped: true, status });
      return status;
    }

    const controller: Controller = { project, stopped: false, status: { projectId, state: "running" } };
    try {
      controller.releaseLease = await acquireLease(project.root);
    } catch (error) {
      controller.stopped = true;
      controller.status = { projectId, state: "blocked", error: error instanceof Error ? error.message : String(error) };
      this.controllers.set(projectId, controller);
      return controller.status;
    }
    this.controllers.set(projectId, controller);
    await this.tick(controller);
    return controller.status;
  }

  async stop(projectId: string): Promise<SupervisedRuntimeStatus> {
    const controller = this.controllers.get(projectId);
    if (!controller) return { projectId, state: "stopped" };
    controller.stopped = true;
    if (controller.timer) clearTimeout(controller.timer);
    await this.handlers.stopPolling?.(controller.project.root);
    await controller.ticking;
    await controller.releaseLease?.();
    controller.releaseLease = undefined;
    controller.status = { ...controller.status, state: "stopped", nextTickAt: undefined };
    return controller.status;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.controllers].map(([projectId]) => this.stop(projectId)));
  }

  status(projectId?: string): SupervisedRuntimeStatus[] {
    return [...this.controllers.values()]
      .filter((controller) => !projectId || controller.project.id === projectId)
      .map((controller) => ({ ...controller.status }));
  }

  private async tick(controller: Controller): Promise<void> {
    if (controller.stopped) return;
    controller.ticking = (async () => {
      try {
        const context = await this.projects.context(controller.project.id);
        if (this.handlers.poll) await this.handlers.poll(context);
        else await this.handlers.once!(context, {});
        controller.status = { projectId: controller.project.id, state: "running", lastTickAt: new Date().toISOString() };
        if (controller.stopped) return;
        const interval = this.handlers.poll ? Math.min(1_000, pollingInterval(context)) : pollingInterval(context);
        const next = Date.now() + interval;
        controller.status.nextTickAt = new Date(next).toISOString();
        controller.timer = setTimeout(() => { void this.tick(controller); }, interval);
      } catch (error) {
        if (controller.stopped) return;
        const interval = 30_000;
        controller.status = {
          projectId: controller.project.id,
          state: "failed",
          lastTickAt: new Date().toISOString(),
          nextTickAt: new Date(Date.now() + interval).toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        controller.timer = setTimeout(() => { void this.tick(controller); }, interval);
      }
    })();
    await controller.ticking;
    controller.ticking = undefined;
  }
}

function pollingInterval(context: RelayCommandContext): number {
  const enabled = Object.values(context.config.sources)
    .filter((source) => source.enabled)
    .map((source) => source.pollIntervalMs);
  return enabled.length ? Math.max(1_000, Math.min(...enabled)) : 30_000;
}

async function acquireLease(projectRoot: string): Promise<() => Promise<void>> {
  const directory = stateDirectory(projectRoot);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "supervisor.lease");
  if (!existsSync(file)) writeFileSync(file, `${process.pid}\n`);
  try {
    return await lockfile.lock(file, { stale: 60_000, retries: 0 });
  } catch {
    throw new Error("Another global Relay supervisor already owns this project folder.");
  }
}
