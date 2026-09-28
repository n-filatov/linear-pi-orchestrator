# Claude start-session action

Starts a headless Claude Code session (`claude -p --worktree ...`) via the
`__claude_session` harness, run with `workspaceMode: "project"` so no
managed workspace is created. `worktree` and `name` are Handlebars templates
rendered against the item; the rendered worktree name is sanitized to
`[A-Za-z0-9._-]` and capped at 64 characters, and the rendered title is
whitespace-collapsed and capped at 100 characters.
