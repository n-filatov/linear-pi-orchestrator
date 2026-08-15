import type { RunRecord, Workspace, WorkspaceProvider } from "../domain/index.js";

export type WorkspaceProviderOptions = {
  /** Used when a trigger does not provide `metadata.branchTemplate`. */
  branchTemplate?: string;
  /** Preferred base ref; fallback candidates are checked automatically. */
  baseBranch?: string;
};

export type WorktreeProvider = WorkspaceProvider & {
  provision(run: RunRecord, signal?: AbortSignal): Promise<Workspace>;
  cleanup(workspace: Workspace, run: RunRecord): Promise<void>;
};
