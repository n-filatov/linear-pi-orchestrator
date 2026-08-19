# Task Relay

Task Relay is a repository-scoped automation engine for coding agents. It is not tied to Pi, Linear, Codex, or any one model: a source discovers items, its provider evaluates source-specific match rules, and Relay runs an ordered action pipeline.

The built-ins provide Linear, coding-agent launch, worker control, worker cleanup, and the common harnesses (`codex`, `claude`, `pi`, and `opencode`). Sources, actions, and harnesses can all be added as installed packages or local modules; see [Custom plugins](#custom-plugins).

## Install

On macOS (Apple Silicon or Intel) and Linux x64:

```bash
curl -fsSL https://raw.githubusercontent.com/n-filatov/linear-pi-orchestrator/main/install.sh | sh
```

The installer verifies the release checksum and installs `relay` to `~/.local/bin`, so it does not need `sudo`. If that directory is not already on your `PATH`, the installer prints the exact command to add it.

After the first installation, update or check for a new release with:

```bash
relay update
relay update --check
relay update v0.2.0
```

The updater compares the installed executable with the published SHA-256 digest, smoke-tests the downloaded replacement, and only then atomically replaces the running binary. Restart an existing `relay watch` or daemon process afterward so it uses the new executable.

To install a specific release or choose another destination:

```bash
curl -fsSL https://raw.githubusercontent.com/n-filatov/linear-pi-orchestrator/main/install.sh | RELAY_VERSION=v0.2.0 sh
curl -fsSL https://raw.githubusercontent.com/n-filatov/linear-pi-orchestrator/main/install.sh | INSTALL_DIR="$HOME/bin" sh
```

## Start in a repository

For local development, run this checkout without replacing the installed `relay` CLI:

```sh
npm run dev:cli -- status
# or, after `npm link` from this repository:
relay-dev status
```

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
- `workflows` do the same, but as named jobs with `needs` and `if`, tracked in a durable run. Use one when steps must run in parallel or wait for each other; see [Workflows](#workflows-parallel-jobs-and-dependencies).

`use` and `uses` are accepted interchangeably wherever a plugin is named.

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
      mode: interactive
      model: gpt-5.6-sol
      prompt: |
        Implement {{item.id}}: {{item.title}}

        {{item.description}}

  review:
    use: launch
    with:
      harness: claude
      mode: interactive
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

## A different model for each kind of task

`model` belongs to the action, not to Relay, so routing two kinds of work to two
different models is ordinary configuration. Give each kind its own action and its
own label-matched trigger:

```yaml
harnesses:
  claude: { use: claude }
  codex: { use: codex }

actions:
  decompose:
    use: launch
    with:
      harness: claude
      model: claude-opus-5      # the expensive model, for planning work
      mode: interactive
      prompt: |
        Break {{item.id}} into implementable Linear issues.
        Label each new issue `relay-implement`.

  implement:
    use: launch
    with:
      harness: claude
      model: claude-sonnet-5    # the cheaper model, for mechanical work
      mode: interactive
      prompt: "Implement {{item.id}}: {{item.title}}"

triggers:
  - id: decompose-epic
    source: linear
    match: { labels: { all: [relay-decompose] } }
    actions: [decompose]
  - id: implement-issue
    source: linear
    match: { labels: { all: [relay-implement] } }
    actions: [implement]
```

The decomposition worker writes new issues into Linear with the `relay-implement`
label, and the next poll picks them up. Chaining work across tickets goes through
the source rather than through Relay, so it survives a restart and stays visible
in Linear.

## Acting on a worker that is already running

`launch` creates a worker. These actions address one that exists, in the same
pipeline or from an earlier one. Both require `execution.adapter: tmux`.

| Action | Effect |
| --- | --- |
| `worker-exec` | Opens a pane in the worker's window, or a separate window, running a command in the worker's workspace. |
| `worker-send` | Pastes text into the worker's live session and submits it. |

`worker` names the target: `{ action: <id> }` addresses the worker a named earlier
action created, `{ workerId: <id> }` is explicit, and
`{ sourceItem: current, runs: latest }` (the default) addresses the newest worker
for the item that matched.

```yaml
actions:
  implement:
    use: launch
    with: { harness: codex, mode: interactive, prompt: "Implement {{item.id}}" }

  dev-server:
    use: worker-exec
    with:
      worker: { action: implement }
      open: pane                 # or `window`
      name: dev
      command: npm
      args: [run, dev]

  review:
    use: launch
    with:
      harness: claude
      model: claude-opus-5
      mode: interactive
      workspace: { fromAction: implement }   # same branch and worktree
      prompt: "Review {{branch}} for {{item.id}}."

  ask:
    use: worker-send
    with:
      worker: { sourceItem: current, runs: latest }
      text: "New guidance on {{item.id}}: {{item.title}}"

triggers:
  - id: implement-issue
    source: linear
    match: { labels: { all: [relay-implement] } }
    actions: [implement, dev-server, review]

  - id: ask-the-worker
    source: linear
    match: { labels: { all: [relay:ask] } }
    actions: [ask]
    fire: { policy: on-change }
```

Actions run in the order they are listed. An action that finds no matching worker
is skipped, not failed, so a pipeline does not break when a worker has already
finished. Panes and windows Relay opens are recorded on the worker, so `relay
cleanup` and the `cleanup` action close them too.

`workspace.fromAction` pins a launch to the branch of an earlier action's worker.
Without it two launches for the same item only share a worktree when their branch
templates happen to render the same name.

`mode: interactive` starts the harness's terminal UI (`claude`, `codex`, `pi`, or `opencode`) in a detached tmux window, pastes the rendered prompt into that live session, and submits it. It requires `execution.adapter: tmux`; use `relay attach <task-or-run>` to enter the session. `mode: oneshot` retains the non-interactive behavior (`claude -p`, `codex exec`, and equivalent commands) and exits when the command finishes.

The cleanup trigger does not need a worker ID in YAML. `targets.workers.sourceItem: current` resolves workers associated with the current source item; `runs` can be `latest`, `active`, or `all`. Cleanup only removes Relay-owned workspaces/branches and is idempotent once a worker has `workspaceCleanedAt`.

## Workflows: parallel jobs and dependencies

A `triggers:` entry runs its actions in order, every poll. A `workflows:` entry
adds what that cannot express: jobs that run in parallel, jobs that wait for
another job, and a durable record of where the whole thing got to.

Relay borrows GitHub Actions' vocabulary — `jobs`, `needs`, `if`, `outputs`,
`uses` — but not its execution model. GitHub holds a workflow run in a live
controller and every job finishes inside it. A Relay job launches an agent that
outlives the tick, so a workflow run is a **persisted record that each poll
advances by one step**. Nothing blocks and nothing is held open in memory.

```yaml
workflows:
  feature:
    on:
      source: linear
      match:
        labels: { all: [relay-implement], none: [relay:running, relay:done] }
        assignee: me
      fire: { policy: every-poll }
    timeoutMinutes: 720
    jobs:
      implement:
        uses: "@notwhale/relay-implement-linear"
        with: { harness: codex, mode: interactive }

      # Both of these start as soon as the agent's window exists.
      dev-server:
        needs: implement.Started
        uses: worker-exec
        with: { worker: { action: implement }, open: pane, name: dev, command: npm, args: [run, dev] }

      lint:
        needs: implement.Started
        uses: worker-exec
        with: { worker: { action: implement }, open: pane, name: lint, command: npm, args: [run, check] }

      # This one waits for the agent to finish.
      review:
        needs: implement
        if: ${{ needs.implement.outputs.changed == 'true' }}
        uses: launch
        with:
          harness: claude
          model: claude-opus-5
          mode: interactive
          workspace: { fromAction: implement }
          prompt: "Review {{branch}} for {{item.id}}."

      report:
        needs: [review, lint]
        if: ${{ always() }}
        uses: command
        with: { command: gh, args: [pr, comment, "--body", "review: ${{ needs.review.result }}"] }
```

### Job states

| State | Meaning |
| --- | --- |
| `pending` | Not started, or waiting for a dependency |
| `started` | Launched an agent that is still running |
| `succeeded` | Finished without error |
| `failed` | Raised, or its agent exited non-zero |
| `skipped` | Its `if:` was false |
| `omitted` | A dependency can no longer be satisfied, or the run timed out |

`started` is the state GitHub Actions has no need for and Relay cannot do
without. A dev-server pane depends on the agent having **started**; a review
agent depends on it having **finished**. Write those as `needs: implement.Started`
and `needs: implement`.

### needs

`needs` takes a job name, a name with a status suffix, or a list of either.
A bare name means `Succeeded` or `Skipped`, the same default Argo Workflows uses.
Suffixes are `Started`, `Succeeded`, `Failed`, and `Skipped`.

A dependency that can never be met settles the job as `omitted` rather than
leaving it pending for ever — unless the job has an `if:`, which is then given
the chance to run it anyway.

### if

`if:` is a GitHub Actions expression, evaluated by GitHub's own parser. `${{ }}`
is optional. Available contexts are `item`, `needs`, and `jobs`; available status
functions are `success()`, `failure()`, `cancelled()`, and `always()`. Omitting
`if:` means `success()`.

Two template languages, split by **when** they are evaluated:

- `${{ }}` is evaluated by the scheduler, before a job starts — `if`, `needs`, `outputs`.
- `{{ }}` is Handlebars, evaluated by the launcher when a prompt is rendered.

### Telling Relay a job is done

An interactive agent does not exit when it stops working, so `needs: implement`
would never fire. End the prompt by telling the agent to report itself:

```bash
relay signal "$TASK_RELAY_WORKER_ID" done --output changed=true --output pr="$URL"
```

Relay sets `TASK_RELAY_WORKER_ID`, `TASK_RELAY_ITEM_ID`, and
`TASK_RELAY_REPOSITORY` in every worker's environment. Outputs are recorded
before the result, so a dependent job never sees a finished job with its outputs
missing. `mode: oneshot` jobs need no signal — the process exit is the result.

A job whose action reports "nothing to do yet" stays `pending` and is retried on
the next poll. `timeoutMinutes` (default 1440) is the backstop: when it passes,
every unfinished job becomes `omitted` and the run fails, so an unsatisfiable
dependency cannot stall a workflow for ever.

### Reruns

| `fire.policy` | Behaviour |
| --- | --- |
| `once-per-item`, `once-per-match` | One run per item, ever |
| `on-change` | A new run each time the item changes |
| `every-poll` | A new run once the previous one has finished, so a reopened ticket runs again while a live one is never duplicated |

### Inspecting a run

```bash
relay workflow test feature    # matched items, each job, and what would start now
relay workflow runs            # every run, with each job's state and why it is blocked
relay workflow runs --json
relay dashboard                # the same, in a browser, updating as it happens
```

`relay dashboard` shows every workflow with its declared jobs, each run's job
states, and the edge each waiting job is blocked on. A **Test** button runs the
same dry run without changing anything. Its Plugins tab reports what this
project references and whether it is installed, and its Workers tab can send a
prompt into a live worker or open a pane beside it. A live event feed streams
the structured log at the bottom of every tab.

Workflows are editable there too, under **Configuration → Workflows**. A job's
configuration form is generated from the selected plugin's own schema, so an
installed plugin's fields — with their types, enums, defaults, and which are
required — appear without a line of dashboard code written for it. Anything the
schema cannot describe falls back to a JSON editor, and a toggle switches to raw
JSON at any time.

Jobs are also reusable: a job's `uses` may name an entry in `actions:`, in which
case that action's `with` is the base and the job's `with` overrides it.

### Editor completion

The configuration is data, so an editor can check it for you. Generate a JSON
Schema from the same definitions Relay validates with:

```bash
relay config schema --write
```

Then add its first line to `.task-relay.yaml`:

```yaml
# yaml-language-server: $schema=./.task-relay.schema.json
```

Every key, enum, and default above is then completed and validated as you type.
`relay config schema` alone prints the schema to stdout.

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

### Installing a plugin

```bash
relay plugin install @company/relay-github-source
relay plugin install ../relay-implement-linear      # a local directory
relay plugin install ./relay-thing-1.0.0.tgz        # a packed tarball
relay plugin list
relay plugin remove @company/relay-github-source
```

Plugins install into a user-level directory —
`${XDG_DATA_HOME:-~/.local/share}/task-relay/plugins`, or `RELAY_PLUGIN_HOME` if
set — and are recorded in `plugins.json` with their version, kind, `use`, the
absolute path of their entry point, and a SHA-256 of it. Project configuration
holds only the package name.

That absolute path is the point. The released `relay` is a single compiled
executable whose module root has no `node_modules`, so it cannot resolve a bare
package name at all. Resolving through the lockfile is what lets an installed
plugin work from the released binary as well as from a checkout. A plugin's own
dependencies resolve normally, because npm installs them into the same managed
directory.

`relay doctor` reports every configured plugin as installed, not installed,
missing on disk, or changed since install, before any worker is launched.
`relay plugin remove` refuses while the current project still references the
plugin, unless you pass `--force`.

To publish one, `relay plugin pack` produces a checksummed tarball:

```bash
relay plugin init @company/relay-github-source --kind source
relay plugin validate .
relay plugin pack . --out dist
```

### Harness plugins

A `kind: harness` plugin starts and owns its own agent process, rather than
being launched through Relay's execution adapter. It receives a rendered prompt,
a workspace, and its validated configuration, and returns the worker handle
Relay persists:

```yaml
harnesses:
  my-agent:
    uses: "@company/relay-my-agent-harness"
    with: { endpoint: https://agents.internal }
```

Relay routes `launch`, `wait`, `reconcile`, and `stop` for that harness to the
plugin, and everything else — the run store, workflows, cleanup — behaves as it
does for a built-in harness. A harness plugin does not need
`execution.adapter: tmux`, because Relay is not hosting its terminal. It also
has no attachable session, and `worker-exec` and `worker-send` do not apply to
its workers. Implement `reconcile` if the worker should survive a relay restart;
without it, Relay reports the worker as failed after a restart rather than
guessing.

Plugin packages import the extension contracts from `task-relay/plugin`:

```ts
import type { ActionContext, ActionPlugin, ActionResult } from "task-relay/plugin";
```

That entry point exports only the plugin contracts and the domain types they use.
It never pulls in Relay's CLI, dashboard, daemon, or state store, so a plugin's
`tsc` does not have to resolve Relay's own runtime dependencies. Everything it
exports is covered by Relay's semantic versioning: a breaking change to those
types requires a major release. Do not import from `task-relay` itself or from
`task-relay/src/...`.

For a custom local coding CLI, the built-in `command` harness is usually enough: give it an executable, its arguments, and how it takes a prompt. Reach for a harness plugin when the agent is not a local command — a hosted service, or anything whose lifecycle Relay cannot express as one process.

## Commands and observability

```bash
relay doctor                    # config, plugin health, and harness checks
relay plugin install <package>  # install into the managed plugin directory
relay plugin list               # installed plugins and what this project uses
relay status                    # sources, harnesses, actions, triggers, and run state
relay runs                      # persisted worker/run table
relay logs --level error
relay logs --task ENG-123 --follow
relay config schema --write        # JSON Schema for editor completion
relay trigger test implement-linear-issue
relay workflow test feature       # preview a workflow's job graph
relay workflow runs               # persisted workflow runs and job states
relay signal ENG-123 done --output changed=true
relay once --trigger implement-linear-issue
relay watch --trigger implement-linear-issue
relay attach ENG-123              # enter the latest matching tmux worker
relay update [version] [--check]
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
