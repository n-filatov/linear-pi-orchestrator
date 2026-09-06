import type { ActionPlugin } from "../plugins/index.js";
import { CODEX_APP_SERVER_HARNESS_ID, type CodexAppServerHarness } from "../codex/index.js";
import { TMUX_WINDOW_HARNESS_ID } from "../runtime/index.js";
import { readPromptFile } from "../prompts/library.js";
import { createLaunchAction } from "@task-relay/action-launch";
export * from "@task-relay/action-launch";
import { createCleanupAction } from "@task-relay/action-cleanup";
export * from "@task-relay/action-cleanup";
import { createCommandAction } from "@task-relay/action-command";
export * from "@task-relay/action-command";
import { createWorkerExecAction } from "@task-relay/action-worker-exec";
export * from "@task-relay/action-worker-exec";
import { createWorkerSendAction } from "@task-relay/action-worker-send";
export * from "@task-relay/action-worker-send";
import { createTmuxCreateWindowAction } from "@task-relay/action-tmux-create-window";
export * from "@task-relay/action-tmux-create-window";
import { createCodexStartSessionAction } from "@task-relay/action-codex-start-session";
export * from "@task-relay/action-codex-start-session";
import { createCodexSendPromptAction } from "@task-relay/action-codex-send-prompt";
export * from "@task-relay/action-codex-send-prompt";

export function builtInActionPlugins(options: { codexAppServer?: CodexAppServerHarness } = {}): readonly ActionPlugin[] {
 return [createLaunchAction({ readPromptFile }), createCleanupAction(), createCommandAction(), createWorkerExecAction(), createWorkerSendAction(), createTmuxCreateWindowAction({ harnessId: TMUX_WINDOW_HARNESS_ID }), createCodexStartSessionAction({ ...options, harnessId: CODEX_APP_SERVER_HARNESS_ID, readPromptFile }), createCodexSendPromptAction({ ...options, readPromptFile })];
}
