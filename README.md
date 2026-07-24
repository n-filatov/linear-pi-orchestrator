# Linear Pi Orchestrator

Watches Linear issues and starts dedicated tmux + `wt` worktree + AI agent workers. Works two ways:

- **CLI** — standalone binary, no Pi required. Uses the same Linear MCP OAuth flow (no API key needed).
- **Pi extension** — runs inside a Pi coding agent session, adding `/linear-start`, `/linear-watch`, etc.

## Install — CLI binary

**One-line install (macOS + Linux):**
```bash
curl -fsSL https://raw.githubusercontent.com/n-filatov/linear-pi-orchestrator/main/install.sh | sh
```

To install to a custom directory (e.g. `~/.local/bin`):
```bash
INSTALL_DIR=~/.local/bin curl -fsSL https://raw.githubusercontent.com/n-filatov/linear-pi-orchestrator/main/install.sh | sh
```

On first run, `linear-pi` opens a browser window for Linear OAuth. Tokens are stored in `~/.pi/linear-pi/oauth/` and reused on subsequent runs.

**Update to the latest release:**
```bash
linear-pi update
```

The CLI also checks for updates in the background once every 24 hours and prints a notice at the end of the next command when a new release is available.

## CLI usage

```bash
linear-pi update                         # update binary to the latest release
linear-pi start CRM-123                  # start one worker manually
linear-pi watch start                    # start background daemon
linear-pi watch start pi:frontend        # set label and start daemon
linear-pi watch foreground               # run watcher in foreground (blocking)
linear-pi watch stop                     # stop daemon
linear-pi watch once                     # run one poll tick
linear-pi watch once pi:backend          # set label and run one tick
linear-pi watch model claude             # set worker agent (pi/claude/codex/opencode)
linear-pi watch status                   # show daemon state and recent logs
linear-pi watch logs                     # show recent logs
linear-pi cleanup                        # interactive picker
linear-pi cleanup done                   # clean workers whose issue is done/canceled
linear-pi cleanup CRM-123               # clean one worker
linear-pi cleanup all                    # clean all workers
linear-pi status                         # show recorded workers
linear-pi -C /path/to/repo watch start   # target a specific repo root
```

## Install — Pi extension

Global install for local development. Symlink the repo root (not the entry file directly) so Pi's package.json-based
extension resolution picks up `pi.extensions` and relative imports between `src/` files resolve correctly:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD" ~/.pi/agent/extensions/linear-pi-orchestrator
```

Then restart Pi or run `/reload`.

You can also install it as a Pi package from this repo once it is pushed to GitHub.

## Commands

- `/linear-start CRM-123` — start one worker manually.
- `/linear-watch start` — start a detached background watcher daemon for issues with the configured label.
- `/linear-watch start pi:frontend` — set watched label to `pi:frontend` and start the background watcher daemon.
- `/linear-watch foreground pi:frontend` — run the watcher in the current Pi process instead of the daemon.
- `/linear-watch stop` — stop the foreground watcher and this repo's daemon.
- `/linear-watch once` — run one polling tick.
- `/linear-watch once pi:backend` — set watched label to `pi:backend` and run one tick.
- `/linear-watch model` — open a picker to choose which agent CLI runs in each worker (`pi`, `claude`, `codex`, `opencode`). Defaults to `pi`.
- `/linear-watch model claude` — set the worker agent directly (also `codex`, `opencode`, `pi`). Persisted in the repo's watcher config.
- `/linear-watch status` — show watcher state/config paths and recent logs.
- `/linear-watch logs` — show recent watcher logs.
- `/linear-watch-bar on|off|toggle|status|refresh` — control the footer status item (`Linear: ...`).
- `/linear-status` — show recorded workers.
- `/linear-cleanup` — show a picker of running workers and clean the selected tmux window + worktree.
- `/linear-cleanup done` — clean workers whose Linear issue is done/canceled or has `pi:done`.
- `/linear-cleanup CRM-123` — clean one worker by issue id.
- `/linear-cleanup all` — clean all recorded workers.

## Files

First use creates a global defaults file plus per-repository runtime files:

- global defaults: `~/.pi/linear-pi/config.json`
- per-repo config/state/logs/pid: `~/.pi/linear-pi/repos/<repo-name>-<hash>/`

## Cleanup behavior

`/linear-cleanup` without arguments opens an interactive picker of recorded running workers, then kills the selected tmux window and removes its `wt` worktree after confirmation.

`/linear-cleanup done` checks recorded workers for the current repository, fetches each issue through Linear MCP, and removes the worker when the Linear issue has `pi:done`, `statusType: completed`, `statusType: canceled`, `status: Done`, or `status: Canceled`.

The extension also auto-cleans done workers during watcher polling and watches successful Linear MCP `save_issue` calls. If an issue with a recorded worker is marked done/canceled or receives `pi:done`, it automatically runs the same cleanup path as `/linear-cleanup` for that worker.

For every cleaned worker it kills the tmux window, runs `wt remove <branch> --force -D --foreground -y --no-hooks`, removes the trigger/running labels from Linear so the watcher does not immediately recreate it, and removes the worker from local state. When cleaning a done/canceled issue, it also ensures the `pi:done` label is present. After the last recorded worker is cleaned, the repo-scoped temp folder under `~/.pi/linear-pi/repos/` is removed when the watcher is not running.

## Default behavior

The watcher searches Linear MCP server `linear` for issues labeled with the current repository's `triggerLabel` (default `pi:implement`) and, by default, assigned to the authenticated Linear user (`assignee: "me"`). All `/linear-watch`, `/linear-start`, `/linear-cleanup`, `/linear-status`, and footer status commands resolve the current Pi session's git repository root and use that repository's scoped config/state/log/pid files. This lets one window show/control only the frontend daemon and another window show/control only the backend daemon. The watcher skips issues already labeled `pi:running`, `pi:done`, or `pi:blocked`, and issues whose Linear status is done/canceled.

Security guard: workers only start for issues with the trigger label and, unless disabled, assigned to `watchAssignee` (`me` by default). This applies to both `/linear-watch` and manual `/linear-start`. The current Linear MCP tools do not expose who added a label, so the extension cannot verify the label actor; assignment-to-you is the enforceable guard.

You can change the watched label from Pi:

```text
/linear-watch start pi:frontend
/linear-watch once pi:backend
```

`/linear-watch start` runs as a detached daemon for the current repository by default, so it survives `/clear` and lets the current Pi session continue running other commands. `/linear-watch status` prints that repo's daemon pid, watched label, repo root, required assignee, poll interval, worker count, config/state paths, log path, and recent in-memory logs when available. The footer status item is enabled per repo by default and can be controlled with `/linear-watch-bar on|off|toggle|status|refresh`; it shows compact current-repo daemon/worker state such as `Linear: 🟢 frontend daemon 12345 · 2 workers`.

When a Linear description contains markdown images, the worker prompt keeps those images in the description and adds a local saved-file reference next to each image. The same files are also listed in the Linear attachments section for quick lookup.

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
- `LINEAR_PI_REPO_ROOT=/Users/nikita.filatov/Development/frontend` (initial/default value; commands update this to the active Pi session's git root)
- `LINEAR_PI_BASE_BRANCH=origin/main`
- `LINEAR_PI_BRANCH_PREFIX=feat`
- `LINEAR_PI_AGENT=pi` (worker agent CLI: `pi`, `claude`, `codex`, or `opencode`; persisted via `/linear-watch model`)
- `LINEAR_PI_AGENT_COMMAND` (override the binary used for the selected agent, e.g. an absolute path)
- `LINEAR_PI_<AGENT>_COMMAND` (per-agent binary override, e.g. `LINEAR_PI_CLAUDE_COMMAND=/Users/me/.claude/local/claude`)

Workers launch via `bash -lc`, so the agent command must be resolvable there. The watcher resolves each agent to an absolute path (probing `PATH` plus common install locations like `~/.claude/local/claude`) so it still works when the command is only available through a shell alias/function (for example a fish `claude` wrapper). Set `LINEAR_PI_<AGENT>_COMMAND` if your binary lives elsewhere.
- `LINEAR_PI_NODE_BIN_DIR=/Users/nikita.filatov/.local/share/nvm/v23.11.1/bin`
- `LINEAR_PI_POLL_INTERVAL_MS=30000`
- `LINEAR_PI_REQUIRE_ASSIGNEE_ME=true`
- `LINEAR_PI_WATCH_ASSIGNEE=me`
- `LINEAR_PI_RESOURCE_CHECK_ENABLED=true` (set `false` to disable the capacity guard below)
- `LINEAR_PI_MIN_FREE_MEMORY_MB=1024` (refuse to start a worker if free RAM drops below this)
- `LINEAR_PI_MIN_FREE_MEMORY_PERCENT=10` (refuse to start a worker if free RAM drops below this percentage of total)
- `LINEAR_PI_MAX_LOAD_AVERAGE_PER_CPU=4` (refuse to start a worker if 1-minute load average per CPU core exceeds this; `0` disables the load check)

## Server capacity guard

Before starting a worker (from `/linear-watch` polling or a manual `/linear-start`), the orchestrator checks free memory and load average against the thresholds above. If the server doesn't have enough headroom, it logs a warning (`Skipping worker start for <ID>: insufficient server capacity ...` / `Refusing to start <ID>: ...`) and does not spawn the agent — the watcher retries the issue on its next poll instead of piling on more workers and crashing the box. Tune the thresholds or set `LINEAR_PI_RESOURCE_CHECK_ENABLED=false` if you want the old unguarded behavior.

## Notes

This uses Linear through MCP, not a Linear personal API key. If auth expires, authenticate the existing `linear` MCP server in Pi, then retry.
