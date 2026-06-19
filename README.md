# Linear Pi Orchestrator

Pi extension that starts a dedicated tmux + `wt` worktree + Pi worker for Linear issues using the existing Linear MCP OAuth connection.

## Install

Global install for local development:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD/index.ts" ~/.pi/agent/extensions/linear-pi-orchestrator.ts
```

Then restart Pi or run `/reload`.

You can also install it as a Pi package from this repo once it is pushed to GitHub.

## Commands

- `/linear-start CRM-123` — start one worker manually.
- `/linear-watch start` — poll Linear for issues with the configured label and start workers.
- `/linear-watch start pi:frontend` — set watched label to `pi:frontend` and start polling.
- `/linear-watch stop` — stop polling.
- `/linear-watch once` — run one polling tick.
- `/linear-watch once pi:backend` — set watched label to `pi:backend` and run one tick.
- `/linear-watch status` — show watcher state/config paths and recent logs.
- `/linear-watch logs` — show recent watcher logs.
- `/linear-status` — show recorded workers.
- `/linear-cleanup` — show a picker of running workers and clean the selected tmux window + worktree.
- `/linear-cleanup done` — clean workers whose Linear issue is done/canceled or has `pi:done`.
- `/linear-cleanup CRM-123` — clean one worker by issue id.
- `/linear-cleanup all` — clean all recorded workers.

## Files

First use creates:

- config: `~/.pi/linear-pi/config.json`
- state: `~/.pi/linear-pi/state.json`

## Cleanup behavior

`/linear-cleanup` without arguments opens an interactive picker of recorded running workers, then kills the selected tmux window and removes its `wt` worktree after confirmation.

`/linear-cleanup done` checks recorded workers in `~/.pi/linear-pi/state.json`, fetches each issue through Linear MCP, and removes the worker when the Linear issue has `pi:done`, `statusType: completed`, `statusType: canceled`, `status: Done`, or `status: Canceled`.

For every cleaned worker it kills the tmux window, runs `wt remove <branch> --force -D --foreground -y --no-hooks`, and removes the worker from local state.

## Default behavior

The watcher searches Linear MCP server `linear` for issues labeled with `triggerLabel` from `~/.pi/linear-pi/config.json` (default `pi:implement`), skipping issues already labeled `pi:running`, `pi:done`, or `pi:blocked`.

You can change the watched label from Pi:

```text
/linear-watch start pi:frontend
/linear-watch once pi:backend
```

`/linear-watch status` also prints the currently watched label, poll interval, config/state paths, and recent logs. While the watcher runs, it updates a `Linear watch` widget/status with the last polling events so you can see what it is doing.

For each issue it:

1. creates branch `feat/<issue-id-and-title-slug>` with `wt switch --create ... --base origin/main`,
2. creates/uses tmux session `linear-pi`,
3. opens a new tmux window,
4. starts `pi --name <ISSUE-ID> <generated prompt>` from the worktree,
5. comments back on the Linear issue.

## Useful env overrides

- `LINEAR_PI_MCP_SERVER=linear`
- `LINEAR_PI_TRIGGER_LABEL=pi:implement`
- `LINEAR_PI_TMUX_SESSION=linear-pi`
- `LINEAR_PI_REPO_ROOT=/Users/nikita.filatov/Development/frontend`
- `LINEAR_PI_BASE_BRANCH=origin/main`
- `LINEAR_PI_BRANCH_PREFIX=feat`
- `LINEAR_PI_NODE_BIN_DIR=/Users/nikita.filatov/.local/share/nvm/v23.11.1/bin`
- `LINEAR_PI_POLL_INTERVAL_MS=30000`

## Notes

This uses Linear through MCP, not a Linear personal API key. If auth expires, authenticate the existing `linear` MCP server in Pi, then retry.
