/**
 * The single source of truth for which `use` names Relay ships itself.
 *
 * Anything not listed here is an external plugin module that must be resolved
 * and loaded. Keeping the lists in one place stops the CLI, the composition
 * root, and `relay doctor` from drifting apart as built-ins are added.
 */
export const BUILT_IN_SOURCES = new Set(["linear", "command"]);

export const BUILT_IN_ACTIONS = new Set(["launch", "cleanup", "command", "worker-exec", "worker-send", "tmux.create-window", "codex.start-session", "codex.send-prompt"]);

/** Harness plugin names Relay can execute through its command launcher. */
export const BUILT_IN_HARNESSES = new Set(["codex", "claude", "pi", "opencode", "command"]);

/** Harnesses with a shipped command profile; `command` is configured entirely by the user. */
export const BUILT_IN_HARNESS_PROFILES = ["codex", "claude", "pi", "opencode"] as const;
