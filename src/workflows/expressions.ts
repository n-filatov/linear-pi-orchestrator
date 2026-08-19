import { Evaluator, Lexer, Parser, data } from "@actions/expressions";

/**
 * Relay evaluates `if:` with GitHub Actions expression syntax, using GitHub's
 * own MIT-licensed parser. Only the syntax is shared: the context names are
 * Relay's, and the status functions are computed from Relay job states.
 *
 * This deliberately does not touch prompt rendering. `${{ }}` is evaluated by
 * the scheduler before a job starts; `{{ }}` is Handlebars, rendered by the
 * launcher when a prompt is built. Splitting them by evaluation time keeps both
 * meanings unambiguous.
 */

/** A named function the expression may call, with its arity. */
type ExpressionFunction = {
  name: string;
  minArgs: number;
  maxArgs: number;
  call: (...args: never[]) => unknown;
};

/** Outcome of the jobs an expression is allowed to reason about. */
export interface ExpressionStatus {
  /** No dependency has failed. */
  success: boolean;
  /** At least one dependency has failed. */
  failure: boolean;
  /** The workflow run was stopped before this job could be considered. */
  cancelled: boolean;
}

export class RelayExpressionError extends Error {
  constructor(expression: string, cause: string) {
    super(`Could not evaluate '${expression}': ${cause}`);
    this.name = "RelayExpressionError";
  }
}

const wrapped = /^\s*\$\{\{([\s\S]*)\}\}\s*$/;

/** Accepts `${{ expr }}` and a bare `expr`, exactly as GitHub Actions does. */
export function expressionSource(expression: string): string {
  return wrapped.exec(expression)?.[1] ?? expression;
}

/**
 * Evaluates a condition against Relay's contexts. Unknown properties resolve to
 * null rather than raising, so `needs.review.outputs.pr` is safe to write before
 * the review job has ever produced an output.
 */
export function evaluateCondition(
  expression: string,
  contexts: Readonly<Record<string, unknown>>,
  status: ExpressionStatus,
): boolean {
  const source = expressionSource(expression);
  const functions = statusFunctions(status);
  try {
    // The lexer reports bad input as UNKNOWN tokens; the parser is what rejects
    // them, so there is no separate lexing error to check here.
    const lexed = new Lexer(source).lex();
    const parsed = new Parser(
      lexed.tokens,
      Object.keys(contexts),
      [...functions.values()].map(({ name, minArgs, maxArgs }) => ({ name, minArgs, maxArgs })),
    ).parse();
    const evaluated = new Evaluator(parsed, dictionaryOf(contexts), functions as never).evaluate();
    return truthy(evaluated);
  } catch (error) {
    throw new RelayExpressionError(expression, error instanceof Error ? error.message : String(error));
  }
}

/**
 * GitHub's status checks, computed from the dependencies Relay already resolved.
 * `success()` is the implicit default when a job declares no condition, so a job
 * with `if: always()` is the only way to run after a failed dependency.
 */
function statusFunctions(status: ExpressionStatus): Map<string, ExpressionFunction> {
  const constant = (name: string, value: boolean): [string, ExpressionFunction] =>
    [name.toLowerCase(), { name, minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(value) }];
  return new Map([
    constant("success", status.success),
    constant("failure", status.failure),
    constant("cancelled", status.cancelled),
    constant("always", true),
  ]);
}

/** GitHub's truthiness: empty string, zero, and null are false; containers are true. */
function truthy(value: { kind: number; coerceString(): string; number(): number }): boolean {
  switch (value.kind) {
    case data.Kind.Null: return false;
    case data.Kind.String: return value.coerceString().length > 0;
    case data.Kind.Boolean:
    case data.Kind.Number: {
      const numeric = value.number();
      return Number.isFinite(numeric) && numeric !== 0;
    }
    default: return true;
  }
}

function dictionaryOf(contexts: Readonly<Record<string, unknown>>): data.Dictionary {
  const dictionary = new data.Dictionary();
  for (const [key, value] of Object.entries(contexts)) dictionary.add(key, expressionData(value));
  return dictionary;
}

/** Converts a plain JSON-shaped value into the evaluator's data model. */
function expressionData(value: unknown): data.ExpressionData {
  if (value === null || value === undefined) return new data.Null();
  if (typeof value === "boolean") return new data.BooleanData(value);
  if (typeof value === "number") return Number.isFinite(value) ? new data.NumberData(value) : new data.Null();
  if (typeof value === "string") return new data.StringData(value);
  if (Array.isArray(value)) {
    const array = new data.Array();
    for (const entry of value) array.add(expressionData(entry));
    return array;
  }
  if (typeof value === "object") {
    const dictionary = new data.Dictionary();
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "function") continue;
      dictionary.add(key, expressionData(entry));
    }
    return dictionary;
  }
  // Functions, symbols, and bigints have no expression representation.
  return new data.Null();
}
