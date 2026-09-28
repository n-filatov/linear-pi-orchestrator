import type { Json, WorkflowSummary } from "./api.js";

export type WorkflowTemplateKind = "agent" | "cleanup" | "claude-review" | "blank";

/** Ready-to-edit templates use the same plugin inputs as repository workflows. */
export function templateFor(
  kind: WorkflowTemplateKind,
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
            permissions: { sandbox: "workspace-write", approvals: "on-request" },
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
  if (kind === "claude-review") {
    // Every turn runs on the one persistent session, so each send-prompt job
    // references the session starter directly rather than the previous
    // prompt; jobs are still chained through `needs` so the turns run in
    // order on that same session.
    const claudePrompt = (needsJob: string, promptFile: string) => ({
      use: "claude.send-prompt",
      needs: [`${needsJob}.succeeded`],
      with: { session: { action: "session" }, promptFile: `.task-relay/prompts/${promptFile}` },
    });
    return {
      ...base,
      jobs: {
        session: { use: "claude.start-session", with: {} },
        implement: {
          use: "claude.send-prompt",
          needs: ["session.started"],
          with: {
            session: { action: "session" },
            promptFile: ".task-relay/prompts/implement.md",
          },
        },
        verify: claudePrompt("implement", "verify.md"),
        "self-review": claudePrompt("verify", "self-review.md"),
        "pull-request": claudePrompt("self-review", "pull-request.md"),
        brief: claudePrompt("pull-request", "review-brief.md"),
        "open-in-app": {
          use: "claude.open-in-app",
          needs: ["brief"],
          if: "${{ always() }}",
          with: { session: { action: "session" } },
        },
      },
    };
  }
  return base;
}

/** Send-prompt requires exactly one prompt representation. */
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
