import type { RunRecord, Workspace, WorkspaceProvider } from "../domain/index.js";

/**
 * Wraps a workspace provider so a run whose trigger requested
 * `workspaceMode: "project"` is handed the repository root directly instead
 * of an isolated worktree. This is for a harness that owns its own workspace
 * lifecycle, such as a persistent Claude Code session started with
 * `claude -p --worktree`.
 */
export function ProjectWorkspaceProvider(inner: WorkspaceProvider, projectRoot: string): WorkspaceProvider {
  return {
    async provision(run: RunRecord, signal?: AbortSignal): Promise<Workspace> {
      if (run.trigger.metadata?.workspaceMode === "project") {
        return { path: projectRoot, metadata: { provider: "project", taskRelay: { createdWorkspace: false, createdBranch: false } } };
      }
      return inner.provision(run, signal);
    },
    async cleanup(workspace: Workspace, run: RunRecord): Promise<void> {
      if (workspace.metadata?.provider === "project") return;
      await inner.cleanup?.(workspace, run);
    },
  };
}
