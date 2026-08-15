# task-relay-plugin-authoring

Create or extend a Task Relay plugin — a source, action, or harness — or determine that built-in configuration already satisfies the request.

## Trigger

Use this skill when the user asks to:
- Add a new integration to Task Relay (new source system, custom action, alternative harness)
- Create a Relay plugin
- Extend Relay with custom behavior
- Wire Relay to a third-party service

## Intake checklist

Before writing any code, collect answers to all of the following:

1. **Trigger source** — where do work items come from? (e.g. Linear, GitHub, Jira, Slack)
2. **Match semantics** — what labels, statuses, or fields filter relevant items?
3. **Action effect** — what should happen when an item matches? (launch agent, send notification, call an API, etc.)
4. **Needed credentials** — which API keys, tokens, or environment variables are required?
5. **Idempotency key** — what prevents the same item from being acted upon twice?
6. **Lifecycle / cleanup** — what happens when a worker finishes or an item reaches a terminal state?
7. **Desired observability** — should lifecycle events be reported back to the source? What should be logged?

## Built-in-first rule

Before scaffolding a plugin, check whether built-in configuration already covers the request.

Built-in pieces:
- **Sources**: `linear` — polls Linear for issues matching labels/statuses/assignee
- **Actions**: `launch` — starts a coding-agent worker; `cleanup` — stops a worker and removes its workspace
- **Harnesses**: `codex`, `claude`, `pi`, `opencode` — coding-agent executors

If the request can be expressed with a `.task-relay.yaml` change alone (new trigger, new label, different prompt), produce the YAML and stop. Do **not** generate a plugin package.

Example: "Create a Relay action that starts a Claude PR-review worker for Linear issues in `In Review` with `relay:review`" — this is fully expressible as:

```yaml
harnesses:
  claude: { use: claude }

actions:
  review-pr:
    use: launch
    with:
      harness: claude
      mode: interactive
      prompt: |
        Review the pull request for {{item.id}}: {{item.title}}.
        Focus on correctness, security, and missing tests.

triggers:
  - id: linear-review-pr
    source: linear
    match:
      labels: { all: [relay:review] }
      statuses: [In Review]
    actions: [review-pr]
    fire: { policy: on-change }
```

## Plugin selection guide

If a new plugin is genuinely needed:

| Need | Kind |
|------|------|
| Poll a new system for work items | `source` |
| Take an action when an item matches (call an API, send a message, launch a custom process) | `action` |
| Launch a coding agent not in the built-in list | `harness` |

## Scaffolding a plugin

Use the CLI to generate the package structure:

```bash
relay plugin init <package-name> --kind <source|action|harness> --use <short-name>
```

This creates:
```
<package-name>/
  package.json          # name, version, peerDependencies on task-relay + zod
  tsconfig.json
  relay-plugin.json     # machine-readable manifest
  README.md
  src/
    index.ts            # plugin implementation — edit this
    index.test.ts       # unit tests — fill these in
```

## Implementation contract

Every plugin must export a default (or named `plugin`) that satisfies one of:

```typescript
// source
import type { SourcePlugin } from "task-relay";
const plugin: SourcePlugin<Config, Match> = { kind: "source", use: "my-source", configSchema, matchSchema, async discover(ctx) { ... } };
export default plugin;

// action
import type { ActionPlugin } from "task-relay";
const plugin: ActionPlugin<Config> = { kind: "action", use: "my-action", configSchema, async execute(ctx, config) { ... } };
export default plugin;

// harness
import type { HarnessPlugin } from "task-relay";
const plugin: HarnessPlugin<Config> = { kind: "harness", use: "my-harness", configSchema, async launch(req) { ... } };
export default plugin;
```

Use `zod` for `configSchema` (and `matchSchema` for sources). Keep schemas strict — avoid `z.any()` or `z.unknown()` for required fields.

## Safety gate — never act without user approval

Do **not** perform any of these without explicit user confirmation:
- Publish a package to npm (`npm publish`)
- Create a remote repository (`gh repo create`)
- Install a plugin (`relay plugin install`)
- Modify `.task-relay.yaml`
- Push to any remote branch

After generating files, present a summary and wait for the user to approve each action.

## Required verification steps

Before reporting the plugin as ready:

1. **Typecheck** — `npm run check` must pass with no errors
2. **Tests** — `npm test` must pass; all generated test stubs must be filled in
3. **Manifest validation** — `relay plugin validate .` must report "Plugin … is ready"
4. **Dry-run against config** — suggest running `relay trigger test <id>` if the plugin is wired into a local `.task-relay.yaml`

## Handoff format

When the plugin is ready, report:

```
Generated files:
  <package-name>/src/index.ts
  <package-name>/src/index.test.ts
  <package-name>/relay-plugin.json
  <package-name>/README.md

Capability requests: <list any external services, env vars, or tokens needed>

Install command (needs your approval before running):
  relay plugin install ./<package-name>

Config patch (needs your approval before applying):
  # Add to .task-relay.yaml:
  ...yaml...

Rollback:
  relay plugin remove <package-name>
  # Revert the .task-relay.yaml change
```

## relay-plugin.json manifest

The manifest is metadata for discovery and preflight. Relay also validates at runtime with the plugin's Zod schema — the manifest does not replace that.

Required fields: `name`, `version`, `kind`, `use`
Optional: `minRelayVersion`, `description`, `configSchema` (JSON Schema), `capabilities`

```json
{
  "name": "@yourscope/relay-my-plugin",
  "version": "0.1.0",
  "kind": "action",
  "use": "my-plugin",
  "minRelayVersion": "0.1.0",
  "description": "Does X when Y.",
  "capabilities": ["network:https://api.example.com"]
}
```

## Publishing (separate step, user must approve)

When the user approves publishing:

1. `npm run build` — compile TypeScript to `dist/`
2. `npm test` — final check
3. `relay plugin validate .` — contract check
4. `npm publish --access public` — publish to npm (user must run this)

Prefer a public npm package over a local path reference so others can install it.

## Tmux execution note

The built-in `launch` action creates a new **tmux window** in a Relay-owned session. It does not attach to or create panes in the user's current terminal. A `current-window-pane` execution target is a separate feature that does not exist yet — do not attempt to implement it as a plugin.
