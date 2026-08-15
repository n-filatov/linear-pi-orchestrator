import Handlebars from "handlebars";
import type { WorkItem, Workspace } from "../domain/index.js";
import type { TemplateValues } from "./types.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? value as UnknownRecord : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Create the only template context exposed to agent and workspace config. */
export function templateValues(input: {
  workItem: WorkItem;
  workspace: Workspace;
  repository?: string;
  model?: string;
  prompt?: string;
  promptFile?: string;
}): TemplateValues {
  const item = record(input.workItem);
  const space = record(input.workspace);
  const repository = input.repository ?? text(space.repository ?? space.repoRoot ?? space.repositoryRoot);
  const workspace = text(space.path ?? space.worktree ?? space.directory);

  return {
    id: text(item.id),
    key: text(item.key ?? item.identifier ?? item.id),
    title: text(item.title),
    slug: slugify(text(item.title)),
    description: text(item.description),
    url: text(item.url),
    source: text(item.source ?? item.sourceId),
    repository,
    workspace,
    branch: text(space.branch),
    model: input.model ?? "",
    prompt: input.prompt ?? "",
    promptFile: input.promptFile ?? "",
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const handlebars = Handlebars.create();
handlebars.registerHelper("slugify", (value: unknown) => slugify(text(value)));

/**
 * Render a configuration template. This does not invoke a shell: rendered
 * strings are always later supplied as individual argv or environment values.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  return handlebars.compile(template, { noEscape: true, strict: true })(values);
}

export function renderTemplates(templates: readonly string[] | undefined, values: TemplateValues): string[] {
  return (templates ?? []).map((template) => renderTemplate(template, values));
}

export function renderEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
  values: TemplateValues,
): Record<string, string> {
  return Object.fromEntries(Object.entries(environment ?? {}).map(([key, value]) => [key, renderTemplate(value, values)]));
}
