import type { Json, WorkflowSummary } from "./api.js";

/** Ready-to-edit templates use the same plugin inputs as repository workflows. */
export function templateFor(
  kind: "agent" | "cleanup" | "blank",
  id: string,
  config: Json,
): WorkflowSummary | undefined {
  const source = Object.keys(config.sources ?? {})[0];
  if (!source) return undefined;
  const base: WorkflowSummary = {
    id,
    enabled: true,
    source,
    on: {
      source,
      match: kind === "cleanup" ? { statusTypes: ["completed"] } : {},
      fire: { policy: "once-per-match" },
    },
    timeoutMinutes: 1440,
    jobs: {},
  };
  if (kind === "cleanup")
    return {
      ...base,
      targets: { workers: { sourceItem: "current", runs: "all" } },
      jobs: {
        cleanup: {
          use: "cleanup",
          with: { activeWorker: "stop", ownedTmuxOnly: true },
        },
      },
    };
  if (kind === "agent")
    return {
      ...base,
      jobs: {
        "tmux-window": { use: "tmux.create-window", with: {} },
        "codex-session": {
          use: "codex.start-session",
          needs: ["tmux-window.started"],
          with: {
            tmux: { action: "tmux-window" },
            prompt:
              "Read the repository instructions and inspect the context for {{item.id}}: {{item.title}}. Prepare a brief implementation plan.",
          },
        },
        "agent-task": {
          use: "codex.send-prompt",
          needs: ["codex-session.started"],
          with: {
            codex: { action: "codex-session" },
            prompt:
              "Implement {{item.id}}: {{item.title}}. Follow repository instructions and verify the changes with appropriate checks.\n\n{{item.description}}",
          },
        },
      },
    };
  return base;
}

/** Both Codex actions require exactly one prompt representation. */
export function setPromptInput(
  config: Json,
  name: "prompt" | "promptFile",
  value: string | undefined,
): Json {
  const next = { ...config };
  delete next[name === "prompt" ? "promptFile" : "prompt"];
  if (value?.trim()) next[name] = value;
  else delete next[name];
  return next;
}
