# Task Relay

Task Relay is a repository-scoped automation engine for coding agents. It is not tied to Pi, Linear, Codex, or any one model: a source discovers items, its provider evaluates source-specific match rules, and Relay runs an ordered action pipeline.

The built-ins provide Linear, coding-agent launch, worker cleanup, and the common harnesses (`codex`, `claude`, `pi`, and `opencode`). Other source providers and actions can be added as explicit trusted packages or local modules. Custom CLI harnesses are supported through the built-in `command` harness definition; externally loaded `HarnessPlugin` execution is a future extension seam.

## Install

On macOS (Apple Silicon or Intel) and Linux x64:

```bash
curl -fsSL https://raw.githubusercontent.com/n-filatov/linear-pi-orchestrator/main/install.sh | sh
```

The installer verifies the release checksum and installs `relay` to `~/.local/bin`, so it does not need `sudo`. If that directory is not already on your `PATH`, the installer prints the exact command to add it.

To install a specific release or choose another destination:

```bash
curl -fsSL https://raw.githubusercontent.com/n-filatov/linear-pi-orchestrator/main/install.sh | RELAY_VERSION=v0.2.0 sh
curl -fsSL https://raw.githubusercontent.com/n-filatov/linear-pi-orchestrator/main/install.sh | INSTALL_DIR="$HOME/bin" sh
```

## Start in a repository

```bash
relay init
relay doctor
relay watch
```

`init` detects the repository name/default branch and the available harnesses. It creates a commit-safe v2 `.task-relay.yaml`. For scripts, use:

```bash
relay init --yes --source linear --harness codex --label relay:implement \
  --model gpt-5.6-sol --prompt 'Implement {{item.id}}: {{item.title}}' \
  --max-concurrent 2
```

`--agent` remains a compatibility alias for `--harness`. `init` never stores credentials; use inherited environment variables or connector-managed authentication. Machine-specific changes can go in the untracked `.task-relay.local.yaml`.

## Configuration model

```text
source item -> source-specific match -> ordered actions -> outputs/workers
```

- `sources` declare where items are found.
- `harnesses` declare coding-agent executors. A model is an opaque string owned by the chosen harness, so Relay does not need a stale global model allow-list.
- `actions` are reusable units such as `launch`, `cleanup`, a Slack notification, or a company-specific action.
- `triggers` choose a source, pass it an opaque `match`, select optional worker targets, and run named or inline actions in order.

The core does not interpret fields under `match` or `with`. Their selected source/action/harness plugin validates them when Relay resolves that plugin.

## Example: Linear launch, PR review, and cleanup

```yaml
version: 2
project:
  name: payments-api

sources:
  linear:
    use: linear
    pollIntervalMs: 30000
    with:
      mcp:
        transport: stdio
        command: npx
        args: [-y, mcp-remote, https://mcp.linear.app/mcp]
      reporting:
        runningLabel: relay:running
        blockedLabel: relay:blocked
        doneLabel: relay:done

harnesses:
  codex: { use: codex }
  claude: { use: claude }

actions:
  implement:
    use: launch
    with:
      harness: codex
      model: gpt-5.6-sol
      prompt: |
        Implement {{item.id}}: {{item.title}}

        {{item.description}}

  review:
    use: launch
    with:
      harness: claude
      model: claude-opus-5
      prompt: |
        Review the pull request for {{item.id}}.
        Focus on correctness, security, and missing tests.

  cleanup-worker:
    use: cleanup
    with:
      activeWorker: stop

triggers:
  - id: implement-linear-issue
    source: linear
    match:
      labels:
        all: [relay:implement]
        none: [relay:running, relay:done, relay:blocked]
      statuses: [Todo, Backlog]
      assignee: me
    actions: [implement]
    fire: { policy: once-per-match }
    maxConcurrent: 2

  - id: review-linear-issue
    source: linear
    match:
      labels: { all: [relay:review] }
      statuses: [In Review]
    actions: [review]
    fire: { policy: on-change }

  - id: cleanup-completed-issue
    source: linear
    match:
      statuses: [Done, Canceled]
    targets:
      workers:
        sourceItem: current
        runs: all
    actions: [cleanup-worker]
    fire: { policy: once-per-item }

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

The Linear plugin owns `labels`, `statuses`, and other Linear fields. A GitHub or internal-queue plugin may define completely different match fields.

The cleanup trigger does not need a worker ID in YAML. `targets.workers.sourceItem: current` resolves workers associated with the current source item; `runs` can be `latest`, `active`, or `all`. Cleanup only removes Relay-owned workspaces/branches and is idempotent once a worker has `workspaceCleanedAt`.

## Custom plugins

Built-in short names such as `linear`, `launch`, `cleanup`, and `codex` are ordinary plugin names. Use a package or a local module for a custom source or action plugin:

```yaml
sources:
  github:
    use: "@company/relay-github-source"
    with: { organisation: acme }

actions:
  notify:
    use: "./relay-plugins/slack.js"
    with:
      channel: engineering-agents
      message: "Started {{item.id}}"

triggers:
  - id: notify-review
    source: github
    match: { pullRequest: { draft: false } }
    actions:
      - notify
      - use: launch
        with: { harness: codex, model: gpt-5.6-terra, prompt: "Review {{item.id}}" }
        continueOnError: false
```

Only explicitly configured modules are loaded. Treat plugin modules as trusted code and keep secrets out of YAML.

For a custom local coding CLI today, use the built-in `command` harness with its executable configuration. Relay's external `HarnessPlugin` contract is reserved for a future runtime adapter.

## Commands and observability

```bash
relay doctor                    # config + codex/claude/pi/opencode checks
relay status                    # sources, harnesses, actions, triggers, and run state
relay runs                      # persisted worker/run table
relay logs --level error
relay logs --task ENG-123 --follow
relay trigger test implement-linear-issue
relay once --trigger implement-linear-issue
relay watch --trigger implement-linear-issue
relay cleanup '<worker-id>'
relay daemon start|stop|status
```

`trigger test` should preview the source items, matching result, selected workers, planned actions, and rendered prompt without changing state. Events are structured JSONL under `${XDG_STATE_HOME:-~/.local/state}/task-relay/<repo>-<hash>/events.jsonl`; human tables are rendered from those records.

Version 1 configuration remains accepted and is normalized in memory to version 2. A future `relay config migrate` command can write the equivalent v2 file; no existing repository must be migrated before upgrading.

## Development

```bash
npm install
npm run check
npm test
npm start -- doctor
```
