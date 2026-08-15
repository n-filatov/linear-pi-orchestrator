# NOT-333: Relay plugin authoring skill and plugin distribution plan

## Decision

Do not change Relay production code in this issue. The requested deliverable is
the design and rollout plan for a Claude skill and a distributable Relay plugin
ecosystem. The current repository already contains the useful first seam:

- configuration names a plugin through `use`;
- a plugin can be a source, action, or harness and owns its `with` schema;
- a configured package or local module is dynamically imported as trusted code;
- `launch` already creates an interactive Claude worker in a detached tmux
  **window**.

The example in the issue asks for a pane in the *current tmux window*. That is
not what Relay does today: it deliberately creates a new detached tmux window
and has no stable concept of the user's current tmux client/window. Treat this
as a separate, opt-in execution-target feature rather than making a plugin
issue shell commands to infer a user's terminal state.

## Target user experience

After the rollout, a user can ask Claude:

> Create a Relay plugin that starts a Claude PR-review worker for Linear issues
> in `In Review` with the `relay:review` label.

The Claude skill will:

1. Read the repository's Relay configuration and installed plugin manifests.
2. Decide whether built-in `linear` + `launch` already express the request.
3. If a new capability is needed, propose a scoped plugin package, validate its
   configuration schema, add tests and documentation, then create a separate
   plugin repository from the template.
4. Publish or package only after explicit user approval, and install it with
   `relay plugin install <reference>`.
5. Amend `.task-relay.yaml` only after validation and user confirmation.

For the stated PR-review example, no custom plugin should be generated. It is
already expressible with a Linear trigger and the built-in `launch` action:

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
        Review the pull request for {{item.id}}.
        Focus on correctness, security, and missing tests.

triggers:
  - id: review-linear-pr
    source: linear
    match:
      labels: { all: [relay:review] }
      statuses: [In Review]
    actions: [review-pr]
    fire: { policy: on-change }
```

With `execution.adapter: tmux`, this opens a Relay-owned tmux **window**. A
future pane-target option can be added after its lifecycle and interactive
client semantics are agreed.

## Plugin package contract

Create a separate `relay-plugins` organization/repository, with one package per
plugin, for example `@notwhale/relay-github-source` or
`@notwhale/relay-tmux-pane-action`. Keep the Relay core repository free of
generated, user-specific integrations.

Every plugin package should contain:

```text
package.json                 # name, version, exports, peerDependencies
src/index.ts                 # default or named `plugin` export
src/index.test.ts            # unit tests for schema and behavior
README.md                    # permissions, config, examples, operations
relay-plugin.json            # machine-readable manifest
```

`relay-plugin.json` should declare the package name/version, plugin kind/use,
minimum Relay version, JSON-schema-compatible configuration schema, requested
capabilities, and integrity/release metadata. It is metadata for discovery and
preflight; Relay must still validate with the plugin's runtime Zod schema.

The TypeScript entry point continues to use the existing `SourcePlugin`,
`ActionPlugin`, or `HarnessPlugin` contract. Do not allow a plugin to modify
Relay internals, execute arbitrary shell interpolation, or load plugins merely
because they are present on disk. Installed plugins remain explicit trusted
dependencies referenced by a project's configuration.

## CLI and storage design

Add a future `relay plugin` command group:

| Command | Result |
| --- | --- |
| `relay plugin init <name>` | Scaffolds a plugin repository from the official template. |
| `relay plugin validate [path]` | Loads the manifest in isolation and checks its exported contract/schema. |
| `relay plugin pack [path]` | Produces a versioned, checksummed artifact for local testing or release. |
| `relay plugin install <package@version>` | Installs into Relay's managed plugin directory after manifest/version/integrity checks. |
| `relay plugin list` | Shows installed package, version, kind, and configured projects. |
| `relay plugin remove <package>` | Removes an installed plugin only after confirming it is unused by every known project. |

Use one user-level managed directory (for example
`${XDG_DATA_HOME:-~/.local/share}/task-relay/plugins`) and a lockfile there;
project configuration keeps only package names and versions/references. The
installer resolves a package from the registry/Git source, verifies a signed or
SHA-256 release artifact, installs its production dependencies in an isolated
directory, and writes the lockfile atomically. `relay doctor` should report a
missing, incompatible, or integrity-mismatched configured plugin.

Do not initially implement an in-place repository generator inside a user's
project. `relay plugin init` should create a new repository directory from a
versioned template; `git init`, remote creation, and publishing remain explicit
user-authorized operations.

## Claude skill design

Ship a `task-relay-plugin-authoring` Claude skill in the Relay repository's
`.claude/skills/` directory, then distribute it through the project's standard
Claude skill installation mechanism. The skill should include:

- an intake checklist: trigger source, match semantics, action effect, needed
  credentials, idempotency key, lifecycle/cleanup, and desired observability;
- a built-in-first decision rule, so configuration is preferred over a new
  plugin;
- a plugin selection guide (source vs action vs harness);
- a strict package template and contract examples;
- a safety gate: never publish, create a remote repository, install a package,
  or change a project's config without the user's explicit approval;
- required verification: typecheck, unit tests, `relay plugin validate`, and
  `relay trigger test` against a fixture/dry-run;
- a handoff format that reports generated files, capability requests, install
  command, config patch, and rollback command.

The skill should not grant privileged behavior. It directs Claude to use the
same public Relay CLI and package template as a human author.

## Delivery sequence

1. **Stabilize the public extension ABI.** Export the plugin contracts from the
   published Relay package, document the supported Node versions, define
   semver/compatibility policy, and add contract fixtures.
2. **Add the template and validator.** Implement `relay plugin init` and
   `relay plugin validate`; prove valid source/action/harness fixtures pass and
   malformed exports/schemas fail with actionable errors.
3. **Add local package installation.** Implement a lockfile, integrity checks,
   atomic install/remove, and `doctor` diagnostics. Start with local tarballs
   and a single supported registry before accepting arbitrary Git URLs.
4. **Add remote distribution.** Add registry release metadata, provenance or
   signing, upgrade/downgrade behavior, and a compatibility matrix.
5. **Ship the Claude skill.** Have it use the template/CLI only after steps
   1–3 are usable. Test it with one built-in-only request and one genuinely
   custom action request.
6. **Evaluate tmux panes separately.** Design an execution target such as
   `execution.tmux.target: new-window | current-window-pane`, require a live
   tmux client for the pane option, persist pane ID instead of inferring it,
   and ensure attach/stop/reconcile/cleanup work for both targets. This needs
   integration tests using a real tmux server before release.

## Acceptance criteria for the implementation work

- A Claude skill can turn a natural-language request into either a valid
  built-in configuration change or a tested plugin repository.
- Generated plugins use only the public Relay contract and can be independently
  versioned and released.
- `relay plugin install` is deterministic, integrity-checked, reversible, and
  never installs code that is not explicitly referenced by the user.
- A project's `relay doctor` and `relay trigger test` detect configuration,
  schema, and version problems before any worker is launched.
- The PR-review example works with the built-in configuration and opens a
  Relay-owned tmux window; a pane workflow is added only with explicit lifecycle
  semantics and test coverage.

## Open decisions

1. Which package registry and provenance system will host official plugins?
2. Are private/company plugins permitted, and if so, which authentication is
   allowed for `relay plugin install`?
3. Does “current tmux window” mean the currently attached client only, or may
   Relay select a configured session/window when it runs as a daemon?
4. Should third-party plugins receive a capability allow-list (filesystem,
   network, process, credentials) at install time, or is the initial trust
   model limited to reviewed internal packages?
