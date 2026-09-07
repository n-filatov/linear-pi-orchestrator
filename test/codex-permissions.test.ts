import { describe, expect, it } from "vitest";
import { codexSessionPermissionsSchema } from "../packages/action-codex-start-session/src/index.js";
import { sessionPermissions, threadPermissions, turnPermissions } from "../src/codex/permissions.js";

describe("Codex session permissions", () => {
  it("preserves legacy restrictions and defaults explicitly configured permissions to on-request", () => {
    expect(sessionPermissions(undefined)).toEqual({ sandbox: "workspace-write", approvals: "never" });
    expect(sessionPermissions({})).toEqual({ sandbox: "workspace-write", approvals: "on-request" });
  });
  it("maps workspace network and additional roots without dropping the task worktree", () => {
    const permissions = sessionPermissions({ approvals: "on-request", networkAccess: true, writableRoots: ["/repo/.git", "/repo/.git"] });
    expect(threadPermissions(permissions)).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write", config: { "sandbox_workspace_write.network_access": true } });
    expect(turnPermissions(permissions, "/repo/task")).toMatchObject({ sandboxPolicy: { type: "workspaceWrite", networkAccess: true, writableRoots: ["/repo/task", "/repo/.git"] } });
  });
  it("maps full access and automatic review independently", () => {
    const permissions = sessionPermissions({ sandbox: "danger-full-access", approvals: "auto-review" });
    expect(threadPermissions(permissions)).toEqual({ sandbox: "danger-full-access", approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    expect(turnPermissions(permissions, "/repo").sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });
  it("supports read-only network access without writable folders", () => {
    const permissions = sessionPermissions({ sandbox: "read-only", networkAccess: true });
    expect(turnPermissions(permissions, "/repo").sandboxPolicy).toEqual({ type: "readOnly", networkAccess: true });
  });
  it.each([
    { sandbox: "danger-full-access", networkAccess: false },
    { sandbox: "danger-full-access", writableRoots: [] },
    { sandbox: "read-only", writableRoots: ["/repo"] },
    { writableRoots: ["../outside"] },
    { approvals: "approve-everything" },
  ])("rejects contradictory or invalid settings: %j", (value) => {
    expect(codexSessionPermissionsSchema.safeParse(value).success).toBe(false);
  });
});
