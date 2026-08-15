# Task Relay

Task Relay is a repository-scoped CLI that turns source events into isolated coding-agent workspaces. Sources and triggers decide *which* task is eligible; an agent and model profile decide *how* it runs. The execution engine owns the actual source polling, workspace provisioning, and agent launch so each run can be audited and retried independently.

This project is the migration target for the former Pi extension. It deliberately has no Pi peer dependency, extension metadata, or global Pi configuration. Existing workflows should move to a committed `.task-relay.yaml` beside the repository they automate.

## Start in a repository

Install the package globally (or run it from this checkout), then initialize from the repository you want to automate:

```bash
relay init
relay doctor
relay watch
```

`init` detects the repository name, its default branch, and the availability of `codex`, `claude`, `wt`, and `tmux`. It uses a small interactive wizard; for automation use:

```bash
relay init --yes --source linear --agent codex --label relay:implement \
  --model your-model-id --max-concurrent 2
```

It refuses to overwrite `.task-relay.yaml` unless `--force` is supplied. `--dry-run` prints the generated commit-safe YAML without writing it. Generated configuration contains no credentials. If you need a machine-specific override, use the optional `.task-relay.local.yaml` and keep it untracked; prefer inherited environment variables or connector-managed authentication over storing secrets in Relay YAML.

## Example: Linear routes for Codex and Claude

```yaml
version: 1
project:
  name: payments-api

sources:
  linear:
    type: linear
    pollIntervalMs: 30000
    mcp:
      transport: stdio
      command: npx
      args: [-y, mcp-remote, https://mcp.linear.app/mcp]
    reporting:
      runningLabel: relay:running
      blockedLabel: relay:blocked
      doneLabel: relay:done
      inProgressState: In Progress

agents:
  codex:
    provider: openai
    command: codex
    args: [exec]
    models: [codex-default]
    defaultModelProfile: codex-default
    modelArgument: --model
    promptDelivery: { mode: argument }
  claude:
    provider: anthropic
    command: claude
    args: [-p]
    models: [claude-balanced]
    defaultModelProfile: claude-balanced
    modelArgument: --model
    reasoningEffortArgument: --effort
    promptDelivery: { mode: argument }

modelProfiles:
  codex-default:
    provider: openai
    # model omitted: use the default configured in Codex
  claude-balanced:
    provider: anthropic
    model: sonnet

triggers:
  - id: linear-implementation
    source: linear
    label: relay:implement
    assignee: me
    match: { excludeLabels: [relay:running, relay:done, relay:blocked] }
    agent: codex
    model: codex-default
  - id: linear-review
    source: linear
    label: relay:review
    assignee: me
    match: { excludeLabels: [relay:running, relay:done, relay:blocked] }
    agent: claude
    model: claude-balanced

workspace:
  directory: .task-relay/workspaces
  baseBranch: main
  branchPrefix: relay
execution:
  maxConcurrent: 2
  retries: 2
  adapter: tmux
  tmuxSession: task-relay
logging:
  level: info
  pretty: true
```

The CLI validates all trigger references: every source, agent, and model profile named by a trigger must exist. An agent's `models` list is an allow-list of model profile ids, and its optional `provider` rejects profiles for another provider. Configuration errors name the exact YAML path.

## Commands and observability

```bash
relay doctor                    # config + local executable checks
relay status                    # repository state summary
relay runs                      # persisted run table
relay logs                      # table rendered from JSONL events
relay logs --level error
relay logs --task ENG-123 --follow
relay logs --run '<run-id>' --json
relay trigger test linear-review
relay once --trigger linear-implementation
relay watch --trigger linear-implementation
relay cleanup ENG-123
relay daemon start|stop|status
```

Every event is structured JSONL under `${XDG_STATE_HOME:-~/.local/state}/task-relay/<repo>-<hash>/events.jsonl`, with fields such as `project`, `trigger`, `source`, `task`, `agent`, `model`, `runId`, `event`, `error`, and `duration`. Human tables are rendered directly from those JSON records, never from colored terminal text. Persistent run state is stored beside the log, keyed by repository, source, work item, and trigger, with an atomic write lock to coordinate concurrent CLI processes.

`trigger test` performs source discovery without claiming work. `once` performs one complete dispatch tick, `watch` keeps polling in the foreground, and `daemon` manages a repository-scoped background watcher. Worker exits transition runs to `succeeded` or `failed`, release trigger capacity, and are reconciled from persisted process/tmux metadata after a restart.

Workspace cleanup is ownership-aware. Relay records whether it created the worktree and branch, refuses paths outside the configured workspace directory, and will not force-delete an adopted or legacy workspace. The `wt` adapter uses a Relay-owned Worktrunk config inside that directory, leaving global Worktrunk settings untouched. Completed runs can still be cleaned with `relay cleanup <task-or-run>` without signaling an already-exited process; their terminal result is preserved with a recorded cleanup timestamp.

## Development

```bash
npm install
npm run check
npm test
npm start -- doctor
```

The public CLI composition seam is `createRelayProgram({ handlers })` in `src/cli/program.ts`. Runtime code injects handlers for one-shot dispatch, continuous watch, daemon control, and trigger tests, while configuration, state, logging, and table rendering remain reusable infrastructure.
