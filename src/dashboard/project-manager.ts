import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { RelayCommandContext } from "../cli/program.js";
import { CONFIG_FILE, loadRelayConfig } from "../config/load.js";
import { createEventLogger } from "../logging/events.js";
import { GlobalWorkerRegistry, GlobalWorkflowRegistry, type GlobalProjectFolder } from "../state/global-worker-registry.js";
import { getRepositoryIdentity } from "../state/repository-identity.js";
import { RepositoryStateStore } from "../state/store.js";
import type { RuntimeProjectProvider } from "./runtime-supervisor.js";

export interface ManagedProject extends GlobalProjectFolder {
  /** Convenience alias consumed by the supervisor and dashboard client. */
  root: string;
  workflowCount?: number;
  activeWorkflowRuns?: number;
}

/** A missing folder is a client error, never an internal-server failure. */
export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Unknown project folder '${projectId}'.`);
    this.name = "ProjectNotFoundError";
  }
}

/** Owns the machine-global list of repository folders used by the dashboard. */
export class ProjectManager implements RuntimeProjectProvider {
  readonly workflows: GlobalWorkflowRegistry;
  readonly workers: GlobalWorkerRegistry;
  private readonly loggers = new Map<string, ReturnType<typeof createEventLogger>>();

  constructor(options: { stateHome?: string; file?: string } = {}) {
    this.workflows = new GlobalWorkflowRegistry(options);
    this.workers = new GlobalWorkerRegistry(options);
  }

  close(): void {
    for (const logger of this.loggers.values()) logger.flush();
    this.loggers.clear();
    this.workflows.close();
    this.workers.close();
  }

  async register(root: string, options: { displayName?: string; enabled?: boolean } = {}): Promise<ManagedProject> {
    const loaded = await loadRelayConfig(root);
    const identity = await getRepositoryIdentity(loaded.projectRoot);
    const repository = { id: identity.id, root: identity.root };
    const configHash = createHash("sha256").update(await readFile(loaded.configPath)).digest("hex");
    const project = this.workflows.registerProjectFolder(repository, {
      displayName: options.displayName ?? loaded.config.project.name ?? basename(loaded.projectRoot),
      enabled: options.enabled,
      configHash,
      configStatus: "valid",
    });
    await this.sync(project.id);
    return (await this.get(project.id))!;
  }

  async sync(projectId: string): Promise<ManagedProject> {
    const project = this.require(projectId);
    try {
      const context = await this.context(projectId);
      const repository = { id: project.repository.id, root: project.repository.root };
      const snapshot = await context.store.snapshot();
      this.workflows.importRuns(Object.values(snapshot.workflows), { repository });
      const configHash = createHash("sha256").update(await readFile(`${context.projectRoot}/${CONFIG_FILE}`)).digest("hex");
      this.workflows.updateProjectFolder(projectId, { configHash, configStatus: "valid", at: new Date().toISOString() });
    } catch (error) {
      this.workflows.updateProjectFolder(projectId, { configStatus: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
    }
    return (await this.get(projectId))!;
  }

  async get(projectId: string): Promise<ManagedProject | undefined> {
    const project = this.workflows.getProjectFolder(projectId);
    if (!project) return undefined;
    const runs = this.workflows.list({ projectFolderId: projectId });
    try {
      const loaded = await loadRelayConfig(project.repository.root);
      return {
        ...project,
        root: project.repository.root,
        workflowCount: Object.keys(loaded.config.workflows).length,
        activeWorkflowRuns: runs.filter((run) => run.status === "running").length,
      };
    } catch {
      return { ...project, root: project.repository.root, activeWorkflowRuns: runs.filter((run) => run.status === "running").length };
    }
  }

  async listProjects(): Promise<ManagedProject[]> {
    return Promise.all(this.workflows.listProjectFolders().map((project) => this.get(project.id) as Promise<ManagedProject>));
  }

  async update(projectId: string, patch: { displayName?: string; enabled?: boolean }): Promise<ManagedProject> {
    this.require(projectId);
    this.workflows.updateProjectFolder(projectId, { ...patch, at: new Date().toISOString() });
    return (await this.get(projectId))!;
  }

  async remove(projectId: string): Promise<void> {
    this.require(projectId);
    const logger = this.loggers.get(projectId);
    if (logger) logger.flush();
    this.loggers.delete(projectId);
    this.workflows.removeProjectFolder(projectId);
  }

  async context(projectId: string): Promise<RelayCommandContext> {
    const project = this.require(projectId);
    const loaded = await loadRelayConfig(project.repository.root);
    const identity = await getRepositoryIdentity(loaded.projectRoot);
    let logger = this.loggers.get(projectId);
    if (!logger) {
      logger = createEventLogger(loaded.projectRoot, loaded.config.logging.level, loaded.config.logging.pretty);
      this.loggers.set(projectId, logger);
    }
    return {
      projectRoot: loaded.projectRoot,
      config: loaded.config,
      store: new RepositoryStateStore(loaded.projectRoot),
      logger,
      write: () => undefined,
      registry: this.workers,
      workflowRegistry: this.workflows,
      repositoryIdentity: identity,
    };
  }

  private require(projectId: string): GlobalProjectFolder {
    const project = this.workflows.getProjectFolder(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    return project;
  }
}
