import { ZodError, type ZodIssue } from "zod";
import { dirname } from "node:path";
import { builtInActionPlugins } from "../actions/index.js";
import { RelayPluginRegistry, loadRelayPlugin, readPluginLock, findInstalledPlugin } from "../plugins/index.js";
import { loadReusableWorkflow } from "../config/reusable.js";
import type { RelayConfigV2 } from "../config/v2.js";

export class WorkflowValidationError extends Error {}

/** Validate action inputs without discovering issues, executing jobs, or writing state. */
export async function validateWorkflowActions(config: RelayConfigV2, workflowId: string, projectRoot: string): Promise<void> {
  const workflow = config.workflows[workflowId];
  if (!workflow) return;
  const registry = new RelayPluginRegistry();
  for (const plugin of builtInActionPlugins()) registry.register(plugin);
  const lock = await readPluginLock();
  const declared = workflow.use ? (await loadReusableWorkflow({
    specifier: workflow.use, projectRoot, with: workflow.with,
    lookup: (name) => { const installed = findInstalledPlugin(lock, name); return installed ? dirname(installed.entry).replace(/\/dist$/, "") : undefined; },
    subject: `Workflow '${workflowId}'`,
  })).jobs : workflow.jobs;
  const errors: string[] = [];
  for (const [jobId, job] of Object.entries(declared ?? {})) {
    const reused = config.actions[job.use];
    const use = reused?.use ?? job.use;
    const input = { ...record(reused?.with), ...record(job.with) };
    const subject = `Workflow '${workflowId}', node '${jobId}' (${use})`;
    try {
      if (!registry.action(use)) registry.registerAs(use, await loadRelayPlugin(use, projectRoot, lock));
      registry.parseActionConfig(use, input);
    } catch (error) {
      if (error instanceof ZodError) {
        // Expression-valued fields receive their final type at execution time.
        // Still validate all other fields and cross-field constraints now.
        for (const issue of error.issues) {
          if (expressionAt(input, issue)) continue;
          errors.push(`${subject}${issue.path.length ? `, ${issue.path.join(".")}` : ""}: ${issue.message}`);
        }
      } else errors.push(`${subject}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) throw new WorkflowValidationError(errors.join("\n"));
}
function expressionAt(input: unknown, issue: ZodIssue): boolean {
  if (!issue.path.length) return false;
  let value: any = input;
  for (const key of issue.path) value = value?.[key];
  return typeof value === "string" && value.includes("${{");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
