import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexSessionPermissionsSchema, type CodexSessionPermissions } from "@task-relay/action-codex-start-session";
import type { CodexThreadStartParams, CodexTurnStartParams } from "./app-server-client.js";

export { type CodexSessionPermissions };
export function sessionPermissions(value: unknown): CodexSessionPermissions {
  // Workflows and stored workers without this field retain the original policy.
  return codexSessionPermissionsSchema.parse(value ?? { sandbox: "workspace-write", approvals: "never" });
}
export function threadPermissions(value: CodexSessionPermissions): Pick<CodexThreadStartParams, "approvalPolicy" | "approvalsReviewer" | "sandbox" | "config"> {
  return {
    approvalPolicy: value.approvals === "auto-review" ? "on-request" : value.approvals,
    approvalsReviewer: value.approvals === "auto-review" ? "auto_review" : "user",
    sandbox: value.sandbox,
    ...(value.sandbox === "workspace-write" ? { config: {
      "sandbox_workspace_write.network_access": value.networkAccess ?? false,
      "sandbox_workspace_write.writable_roots": value.writableRoots ?? [],
    } } : {}),
  };
}
export function turnPermissions(value: CodexSessionPermissions, workspace: string): Pick<CodexTurnStartParams, "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy"> {
  return {
    approvalPolicy: value.approvals === "auto-review" ? "on-request" : value.approvals,
    approvalsReviewer: value.approvals === "auto-review" ? "auto_review" : "user",
    sandboxPolicy: value.sandbox === "danger-full-access" ? { type: "dangerFullAccess" }
      : value.sandbox === "read-only" ? { type: "readOnly", networkAccess: value.networkAccess ?? false }
      : { type: "workspaceWrite", writableRoots: [...new Set([workspace, ...(value.writableRoots ?? [])])], networkAccess: value.networkAccess ?? false },
  };
}

const capabilityCache = new Map<string, Promise<{ automaticReview: boolean }>>();
export function codexPermissionCapabilities(command = "codex"): Promise<{ automaticReview: boolean }> {
  let pending = capabilityCache.get(command);
  if (!pending) {
    pending = inspectCapabilities(command).catch(() => ({ automaticReview: false }));
    capabilityCache.set(command, pending);
    const timer = setTimeout(() => capabilityCache.delete(command), 60_000);
    timer.unref();
  }
  return pending;
}
async function inspectCapabilities(command: string): Promise<{ automaticReview: boolean }> {
  const root = await mkdtemp(join(tmpdir(), "relay-codex-permissions-"));
  try {
    await promisify(execFile)(command, ["app-server", "generate-json-schema", "--experimental", "--out", root], { timeout: 10_000, maxBuffer: 1_000_000 });
    const schema = JSON.parse(await readFile(join(root, "v2", "ThreadStartParams.json"), "utf8"));
    return { automaticReview: Boolean(schema.properties?.approvalsReviewer && schema.definitions?.ApprovalsReviewer?.enum?.includes("auto_review")) };
  } finally { await rm(root, { recursive: true, force: true }); }
}
