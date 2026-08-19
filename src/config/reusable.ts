import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { evaluateCondition, expressionSource } from "../workflows/expressions.js";
import { reusableWorkflowFileSchema, withUsesAlias, type ReusableWorkflowFile, type RelayWorkflowJobV2 } from "./v2.js";

/**
 * A workflow whose jobs live in a separate file, so one definition can be used
 * by several repositories.
 *
 * The file declares typed `inputs`; the workflow that uses it supplies `with`.
 * Inputs are substituted at config-load time, which is earlier than `if:` and
 * `needs:` are evaluated — a reusable file is a template, not a second engine.
 */

const inputExpression = /\$\{\{([^}]*)\}\}/g;

export interface ResolvedReusableWorkflow {
  file: ReusableWorkflowFile;
  jobs: Record<string, RelayWorkflowJobV2>;
  /** Absolute path the jobs came from, for error messages. */
  path: string;
}

/**
 * Resolves `use:` to a file. A relative path is resolved against the project; a
 * package-qualified path such as `@company/relay-workflows/review.yaml` is
 * resolved inside that installed plugin's directory, so a workflow ships and
 * versions with the package that owns it.
 */
export async function resolveWorkflowFile(specifier: string, projectRoot: string, lookup?: (name: string) => string | undefined): Promise<string> {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const resolved = path.resolve(projectRoot, specifier);
    if (!existsSync(resolved)) throw new Error(`Reusable workflow file not found: ${resolved}`);
    return resolved;
  }
  const scoped = /^(@[^/]+\/[^/]+)\/(.+)$/.exec(specifier) ?? /^([^@/][^/]*)\/(.+)$/.exec(specifier);
  if (!scoped) {
    throw new Error(`'${specifier}' is not a workflow file. Use a path such as ./relay-workflows/review.yaml, or <package>/<file>.yaml.`);
  }
  const [, packageName, relative] = scoped;
  const directory = lookup?.(packageName);
  if (!directory) {
    throw new Error(`Reusable workflow '${specifier}' needs '${packageName}' installed. Run 'relay plugin install ${packageName}'.`);
  }
  const resolved = path.resolve(directory, relative);
  if (!existsSync(resolved)) throw new Error(`Package '${packageName}' does not contain ${relative}.`);
  return resolved;
}

/** Reads a reusable workflow file and binds the supplied inputs into its jobs. */
export async function loadReusableWorkflow(input: {
  specifier: string;
  projectRoot: string;
  with?: Record<string, string | number | boolean>;
  /** Directory of an installed package, when the specifier names one. */
  lookup?: (name: string) => string | undefined;
  subject: string;
}): Promise<ResolvedReusableWorkflow> {
  const filePath = await resolveWorkflowFile(input.specifier, input.projectRoot, input.lookup);
  let file: ReusableWorkflowFile;
  try {
    file = reusableWorkflowFileSchema.parse(withUsesAlias(parse(await readFile(filePath, "utf8")) as Record<string, unknown>));
  } catch (error) {
    throw new Error(`${input.subject}: ${filePath} is not a valid reusable workflow — ${error instanceof Error ? error.message : String(error)}`);
  }

  const supplied = input.with ?? {};
  const unknown = Object.keys(supplied).filter((name) => !file.inputs[name]);
  if (unknown.length > 0) {
    throw new Error(`${input.subject}: ${filePath} declares no input named ${unknown.map((name) => `'${name}'`).join(", ")}.`);
  }
  const inputs: Record<string, string | number | boolean> = {};
  for (const [name, declared] of Object.entries(file.inputs)) {
    const value = supplied[name] ?? declared.default;
    if (value === undefined) {
      if (declared.required) throw new Error(`${input.subject}: ${filePath} requires input '${name}'.`);
      continue;
    }
    inputs[name] = value;
  }

  return { file, path: filePath, jobs: bindInputs(file.jobs, inputs, `${input.subject}: ${filePath}`) };
}

/**
 * Substitutes `${{ inputs.name }}` throughout a job definition.
 *
 * Only the `inputs` context exists here. An expression naming anything else is
 * left untouched, because `${{ needs.* }}` and `${{ matrix.* }}` belong to
 * later stages and must survive this pass intact.
 */
function bindInputs<T>(value: T, inputs: Record<string, string | number | boolean>, subject: string): T {
  if (typeof value === "string") return substitute(value, inputs, subject) as T;
  if (Array.isArray(value)) return value.map((entry) => bindInputs(entry, inputs, subject)) as T;
  if (value !== null && typeof value === "object") {
    const mapped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) mapped[key] = bindInputs(entry, inputs, subject);
    return mapped as T;
  }
  return value;
}

function substitute(text: string, inputs: Record<string, string | number | boolean>, subject: string): string {
  return text.replace(inputExpression, (whole, body: string) => {
    const source = body.trim();
    if (!/^inputs\b/.test(source)) return whole;
    try {
      // Reuse the same evaluator the scheduler uses, so `inputs.x == 'y'` and
      // format() behave identically here and there.
      const rendered = evaluateExpressionValue(source, inputs);
      return rendered;
    } catch (error) {
      throw new Error(`${subject}: could not resolve '${expressionSource(whole).trim()}' — ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Evaluates an input expression to its string form. */
function evaluateExpressionValue(source: string, inputs: Record<string, string | number | boolean>): string {
  const direct = /^inputs\.([A-Za-z0-9_.:-]+)$/.exec(source);
  if (direct) {
    const value = inputs[direct[1]];
    if (value === undefined) throw new Error(`no value for input '${direct[1]}'`);
    return String(value);
  }
  // Anything more complex is a boolean test; render it as true/false.
  return evaluateCondition(source, { inputs }, { success: true, failure: false, cancelled: false }) ? "true" : "false";
}
