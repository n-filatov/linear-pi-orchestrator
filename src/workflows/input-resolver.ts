import { Evaluator, Lexer, Parser, data } from "@actions/expressions";

export interface WorkflowInputContext {
  trigger: { payload: unknown };
  item: unknown;
  needs: Readonly<Record<string, { outputs?: Readonly<Record<string, unknown>> }>>;
  matrix?: Readonly<Record<string, unknown>>;
  repository: unknown;
}

export interface ResolveWorkflowInputsOptions {
  /** Used in diagnostics, for example `review.with.prompt`. */
  jobId?: string;
  /** Names this job explicitly declared in `needs`. */
  declaredNeeds?: readonly string[];
}

/** Validate expression dependency names without evaluating any input values. */
export function validateWorkflowInputReferences(
  input: unknown,
  declaredNeeds: readonly string[],
  jobId = "job",
): void {
  const declared = new Set(declaredNeeds);
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      validateTemplate(value, declared, jobId, path || "input");
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, entry]) => visit(entry, path ? `${path}.${key}` : key));
    }
  };
  visit(input, "");
}

export class WorkflowInputResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputResolutionError";
  }
}

const expression = /\$\{\{([\s\S]*?)\}\}/g;
const wholeExpression = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/;

/** Resolve a job's input tree once, preserving exact expression value types. */
export function resolveWorkflowInputs<T>(
  inputs: T,
  context: WorkflowInputContext,
  options: ResolveWorkflowInputsOptions = {},
): T {
  const declared = new Set(options.declaredNeeds ?? Object.keys(context.needs));
  const contexts = {
    trigger: context.trigger,
    item: context.item,
    needs: context.needs,
    matrix: context.matrix ?? {},
    repository: context.repository,
  };
  validateWorkflowInputReferences(inputs, [...declared], options.jobId ?? "job");
  return resolveValue(inputs, contexts, declared, options.jobId ?? "job", "") as T;
}

function resolveValue(
  value: unknown,
  contexts: Record<string, unknown>,
  declared: ReadonlySet<string>,
  job: string,
  path: string,
): unknown {
  if (typeof value === "string") {
    const exact = wholeExpression.exec(value);
    if (exact) return evaluate(exact[1], value, contexts, declared, job, path || "input", true);
    if (!value.includes("${{")) return value;
    return value.replace(expression, (_match, source: string) => {
      const result = evaluate(source, _match, contexts, declared, job, path || "input", false);
      return stringifyForInterpolation(result);
    });
  }
  if (Array.isArray(value)) return value.map((entry, index) => resolveValue(entry, contexts, declared, job, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, resolveValue(entry, contexts, declared, job, path ? `${path}.${key}` : key),
    ]));
  }
  return value;
}

function evaluate(
  source: string,
  original: string,
  contexts: Record<string, unknown>,
  declared: ReadonlySet<string>,
  job: string,
  path: string,
  exact: boolean,
): unknown {
  try {
    const parsed = new Parser(new Lexer(source).lex().tokens, Object.keys(contexts), []).parse();
    const evaluated = new Evaluator(parsed, dictionaryOf(contexts), new Map() as never).evaluate();
    const result = fromExpressionData(evaluated);
    // A literal null is an intentional value. A null produced by an absent
    // property is the missing-value error required for job input preflight.
    if ((result === null || result === undefined) && source.trim() !== "null") {
      throw new WorkflowInputResolutionError(`${job}.${path}: missing required value for '${original}'`);
    }
    return result;
  } catch (error) {
    if (error instanceof WorkflowInputResolutionError) throw error;
    throw new WorkflowInputResolutionError(`${job}.${path}: could not resolve '${original}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateTemplate(value: string, declared: ReadonlySet<string>, job: string, path: string): void {
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("${{", cursor);
    const end = value.indexOf("}}", cursor);
    if (end >= 0 && (start < 0 || end < start)) {
      throw new WorkflowInputResolutionError(`${job}.${path}: malformed expression delimiters`);
    }
    if (start < 0) break;
    const close = value.indexOf("}}", start + 3);
    if (close < 0) throw new WorkflowInputResolutionError(`${job}.${path}: malformed expression delimiters`);
    validateNeedsInSource(value.slice(start + 3, close), declared, job, path);
    cursor = close + 2;
  }
}

function validateNeedsInSource(source: string, declared: ReadonlySet<string>, job: string, path: string): void {
  const bracketed = /\bneeds\s*\[\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1\s*\]/g;
  for (const match of source.matchAll(bracketed)) {
    const name = match[2];
    if (name && !declared.has(name)) {
      throw new WorkflowInputResolutionError(`${job}.${path}: undeclared needs reference '${name}'`);
    }
  }
  // Mask quoted strings so text such as `"needs.fake.outputs.x"` is not a
  // dependency. Escapes are retained only to advance over the quoted value.
  const masked = source.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, (literal) => " ".repeat(literal.length));
  const references = /\bneeds\s*\.\s*([A-Za-z0-9_-]+)/g;
  for (const match of masked.matchAll(references)) {
    const name = match[1];
    if (name && !declared.has(name)) {
      throw new WorkflowInputResolutionError(`${job}.${path}: undeclared needs reference '${name}'`);
    }
  }
}

function dictionaryOf(contexts: Record<string, unknown>): data.Dictionary {
  const dictionary = new data.Dictionary();
  for (const [key, value] of Object.entries(contexts)) dictionary.add(key, expressionData(value));
  return dictionary;
}

function expressionData(value: unknown): data.ExpressionData {
  if (value === null || value === undefined) return new data.Null();
  if (typeof value === "boolean") return new data.BooleanData(value);
  if (typeof value === "number") return Number.isFinite(value) ? new data.NumberData(value) : new data.Null();
  if (typeof value === "string") return new data.StringData(value);
  if (Array.isArray(value)) { const array = new data.Array(); for (const entry of value) array.add(expressionData(entry)); return array; }
  if (typeof value === "object") { const dictionary = new data.Dictionary(); for (const [key, entry] of Object.entries(value)) dictionary.add(key, expressionData(entry)); return dictionary; }
  return new data.Null();
}

function fromExpressionData(value: data.ExpressionData): unknown {
  switch (value.kind) {
    case data.Kind.Null: return null;
    case data.Kind.String: return (value as data.StringData).value;
    case data.Kind.Number: return (value as data.NumberData).value;
    case data.Kind.Boolean: return (value as data.BooleanData).value;
    case data.Kind.Array: return (value as data.Array).values().map(fromExpressionData);
    case data.Kind.Dictionary: return Object.fromEntries((value as data.Dictionary).pairs().map(({ key, value: entry }) => [key, fromExpressionData(entry)]));
    default: return null;
  }
}

function stringifyForInterpolation(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
