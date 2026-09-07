import { isAbsolute } from "node:path";
import { z } from "zod";

export const codexSessionPermissionsSchema = z.object({
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  approvals: z.enum(["on-request", "auto-review", "never"]).default("on-request"),
  networkAccess: z.boolean().optional(),
  writableRoots: z.array(z.string().min(1).refine(isAbsolute, "Use an absolute folder path.")).optional(),
}).strict().superRefine((value, context) => {
  if (value.sandbox === "danger-full-access" && (value.networkAccess !== undefined || value.writableRoots !== undefined)) {
    context.addIssue({ code: "custom", message: "Full access already permits filesystem and network access; omit networkAccess and writableRoots." });
  }
  if (value.sandbox === "read-only" && value.writableRoots?.length) {
    context.addIssue({ code: "custom", message: "Read-only sessions cannot have additional writable folders." });
  }
});
export type CodexSessionPermissions = z.infer<typeof codexSessionPermissionsSchema>;
