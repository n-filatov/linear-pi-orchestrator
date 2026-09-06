# Local architecture refactoring plan

Status: in progress. The package/SDK extraction, input-resolution compatibility
work, execution inspection, and SQLite-ledger implementation are in this
checkout. The code includes a fixture-tested legacy JSON importer and a local
`relay state migrate` command, but no production ledger cutover, migration, or
live repository rollout has been performed.

## Implementation checkpoint (2026-09-06)

- [x] Workspace package boundaries for domain, application polling, config,
  plugin SDK/host/testing, built-in actions, command/Linear triggers, the
  Linear MCP integration, SQLite storage, and the global registry are present
  with compatibility exports retained during the migration. Package manifests
  resolve built JavaScript and declarations; development type checks use
  workspace source aliases. The import-boundary check and default-Node import
  smoke cover those public surfaces.
- [x] Versioned trigger/action contracts, explicit action outcomes, schema
  registration validation, and legacy adapters are under test. External and
  local trigger packages now share the host registration path with sources,
  actions, and harnesses.
- [x] The dashboard can inspect a canonical execution with redacted
  inputs/outputs, attempts, operation handles, wait reasons, and retry state.
- [x] Legacy pipelines and workflows now use one executor and lifecycle path.
  Integrated compatibility and recovery coverage passes with the full suite.
- [x] The SQLite ledger, legacy importer, and claim/recovery behavior are
  implemented and covered by disposable fixture and process tests. A controlled
  live cutover remains a separate rollout step; a CLI command existing in this
  checkout is not a live migration.
- [x] Nest/bootstrap and compiled-artifact compatibility are validated. The
  compiled Bun CLI smoke loads a local plugin, persists and reads a workflow
  result, and exits cleanly in a disposable fixture. This is not a production
  release rollout.
- [ ] No existing repository has been migrated. Any restart smoke test must use
  a disposable fixture project and confirm the restarted process uses the new
  code path. No source-only check proves a running local process has changed.

## Outcome and constraints

Run Relay locally with separately packaged triggers and actions, durable workflow execution, predictable variable resolution, and inspectable failures. Preserve the existing CLI, dashboard, YAML workflows, local workspaces, and external plugin loading during migration.

- One local application, with its existing child processes and agent sessions.
- No additional database server, queue server, or hosted workflow service.
- SQLite for the authoritative execution ledger; retain the global registry as a rebuildable index.
- NestJS standalone as the proposed composition framework, subject to the release compatibility check below.
- Plain TypeScript domain rules and plugin implementations; Nest belongs at the application boundary.
- Keep npm, Zod, Vitest, Commander, and the React dashboard. Avoid a package-manager or frontend rewrite in this refactor.
- Implement as small, independently reviewable changes. Structural moves and behavior changes should be separate commits/PRs where practical.

## Current code to preserve or extract

| Current location | Target responsibility |
| --- | --- |
| `src/domain/types.ts` | Domain models and rules; move persistence/runtime interfaces to application ports where appropriate |
| `src/workflows/reconciler.ts`, `needs.ts`, `graph.ts` | Pure dependency decisions and graph validation |
| `src/plugins/contracts.ts`, `loader.ts`, `catalog.ts` | Public SDK, host-side registry/loading, schema-derived catalog |
| `src/actions/builtins.ts` | Individual action packages |
| `src/sources/*`, source construction in `src/app.ts` | Trigger packages and integration clients |
| `src/core/task-relay.ts` | Separate application use cases |
| `src/state/store.ts` | Legacy JSON adapter and migration reader; replacement SQLite ledger |
| `src/state/global-worker-registry.ts` | Global index and reusable Node/Bun SQLite adapter |
| `src/state/indexed-workflow-run-store.ts` | Rebuildable index projection from authoritative state |
| `src/app.ts`, `src/dashboard/runtime-supervisor.ts` | Shared application composition and scheduler lifecycle |

Known behavior to explicitly address: workflow progress tied to discovery results; action invocation without an atomic workflow-job claim; `skipped` meaning both terminal and retry-later; lifecycle inferred from output fields; separate pipeline/workflow execution; multiple template contexts; different CLI/dashboard scheduling paths.

## Package boundaries

```text
apps/
  relay/                         # CLI, Nest bootstrap, dashboard API, scheduling
  dashboard/                     # Existing React UI
packages/
  domain/                        # Definitions, run states, dependency rules
  application/                   # Use cases and ports
  plugin-sdk/                    # Contracts, typed schemas, JSON values
  plugin-host/                   # Registry, loading, compatibility, catalog
  plugin-testing/                # Shared contract fixtures and assertions
  config/                        # YAML parsing and legacy normalization
  storage-sqlite/                # Execution ledger, migrations, SQLite driver
  global-registry/               # Cross-repository index and projections
  trigger-linear-issue-change/
  trigger-command/
  action-launch/
  action-cleanup/
  action-command/
  action-worker-exec/
  action-worker-send/
  action-tmux-create-window/
  action-codex-start-session/
  action-codex-send-prompt/
  integration-linear/
  integration-codex/
  runtime-workers/                # Existing harnesses, tmux, workspace adapters
```

Each trigger/action package owns its manifest, public exports, schemas, implementation, tests, README, and example configuration. Preserve existing `use` aliases even when package names differ. Shared clients live outside action packages; plugins do not import sibling actions.

Dependency rules:

- Domain imports no application, Nest, database, process, integration, or UI code.
- SDK contains public data/contracts, with schema support; it does not import engine internals or Nest.
- Application depends on domain and SDK contracts and declares infrastructure ports.
- Plugins depend on SDK and necessary integration packages; host factories inject concrete dependencies.
- Storage/runtime adapters implement application ports.
- Bootstrap composes implementations. Dashboard receives data-only catalog and execution views.
- Enforce boundaries through package exports, TypeScript project references, and an import-boundary check.

## Contracts and execution semantics

### Trigger plugins

Use a versioned `TriggerPlugin<Config, Payload, Cursor>` with configuration/event schemas and `poll(context, config)` returning events plus a next cursor. Context includes binding identity, persisted cursor, clock, logger, and cancellation. Create one configured instance per binding with explicit disposal of clients.

An event contains binding-scoped stable identity, subject key, observation time, provider revision where available, and immutable payload. Provider-specific matching belongs to the trigger. The host owns scheduling, durable acceptance, and duplicate suppression. Persist a complete accepted page and its checkpoint transactionally; incomplete discovery must not advance the checkpoint.

Keep old source plugins usable through an adapter. Translate existing `sources`, `on.match`, and fire policies into trigger bindings, with a versioned compatibility mode. Snapshot polling cannot promise every intermediate Linear change. Define new semantics separately: `once-per-item` once for a subject; `once-per-match` once per observed entry into a matching set; `on-change` once per observed relevant revision; `every-poll` once per eligible poll after the previous run has finished. Old configurations retain their observed semantics until explicitly migrated. Partial or truncated polling results must not be interpreted as an item leaving the matching set.

### Action plugins

Use a versioned `ActionPlugin<Input, Output>` with input/output schemas, `execute`, and optional `reconcile`/`cancel` for external operations. Return explicit outcomes: `succeeded`, `skipped`, `deferred`, `running`, or `failed`. A running outcome includes a serializable operation handle and any validated initial outputs needed by started dependencies. Completion adds final outputs. Skipped is terminal; deferred specifies when and why to retry.

Context contains stable invocation/idempotency identity, distinct attempt identity, logger, clock, and cancellation. Inject worker/process/integration services through factories instead of giving every plugin all worker capabilities. Preserve legacy ActionContext and result behavior through an adapter, including cleanup-specific compatibility; keep these exceptions outside the new executor.

Distinguish engine invocation state from external operation state. Claim an attempt before effects, then persist success or the operation handle. A lease expiry alone must not blindly repeat an uncertain non-idempotent operation. Reconcile where possible; otherwise show `needs attention` and require a deliberate retry. Completion writes must verify the current attempt generation. Cancellation must record whether the external process actually stopped.

### Workflow and inputs

Persist the workflow definition revision, plugin versions, trigger snapshot, job states, resolved inputs, outputs, attempts, and operation handles. Existing runs continue with their recorded definition. A missing/incompatible plugin version blocks with an actionable message rather than silently changing behavior.

Normalize ordered pipelines into jobs with explicit predecessor dependencies, then use one executor. Preserve current started/succeeded/skipped/omitted and continue-on-error edge semantics in compatibility tests. Started is a recorded milestone: define new-version dependencies so a fast-completing action still satisfies an edge that waits for start.

Resolve inputs centrally before plugin execution. Provide `trigger.payload`, `needs.<job>.outputs`, workflow inputs, matrix values, and repository context. Exact expressions preserve JSON types; interpolation produces strings. Reject undeclared output dependencies and missing required values with job/field paths. Validate resolved inputs and plugin outputs. Persist ordinary execution inputs; credentials remain references and are redacted from inspection.

Preserve legacy Handlebars contexts through an adapter. Do not silently change syntax or run user-supplied expression results through another template pass. Previously completed dependencies retain their outputs on retry; retries reuse the recorded input by default. Rerunning with new inputs creates an explicit new execution.

## Delivery sequence

### 1. Characterize behavior and verify the framework boundary

Work: scope Vitest to this checkout (exclude generated `.task-relay/workspaces`); record existing config/plugin compatibility fixtures; test the critical dependency and worker lifecycle behaviors. Add focused regressions with the behavior fixes rather than landing unexplained failing tests. Prototype Nest standalone bootstrap with explicit factory providers, SQLite access, external plugin loading, and shutdown under Node development and the Bun-compiled artifact.

Exit: current CLI/dashboard checks pass; a compiled smoke fixture can load a plugin, execute a harmless action, persist/read state, and shut down. Measure startup and binary-size changes against the baseline. If Nest cannot preserve the distribution model with modest changes, use the same composition factories directly and document the finding; do not move domain code into Nest to work around it.

### 2. Establish workspace packages and public contracts

Work: add npm workspaces and package-level scripts/exports; extract domain, SDK, host, and shared plugin tests; retain `task-relay/plugin` as a compatibility export. Define versioned trigger and action contracts and adapters before changing execution. Keep source files re-exporting extracted implementations during the transition.

Exit: old imports/configurations still work; external package and local-path fixtures load under development and compiled execution; duplicate IDs, incompatible API versions, malformed schemas, and wrong plugin methods fail at registration. Generic schema types agree with execute input/output types.

### 3. Extract all built-in trigger and action packages

Work: move command trigger/action first as an end-to-end example, followed by Linear and worker/Codex actions. Inject integration clients. Register built-ins and external packages through the same host path. Generate configuration and dashboard catalog metadata from package schemas. Keep existing harness support.

Exit: each plugin has runnable tests and usage examples; adding a fixture trigger and action requires only new packages and registration. No new engine switches or dashboard form branches are needed. Existing Linear reporting, same-pane Codex behavior, sidecars, and cleanup rules are preserved.

### 4. Implement SQLite execution storage and migration tooling

Work: add schema migrations and repositories for trigger checkpoints/events, workflow definitions/runs, jobs/attempts, worker sessions, and a projection outbox. Use unique event/run identities, transactional concurrency admission, atomic attempt claims, generation-checked completion, leases, and bounded SQLite busy handling. Reuse the runtime-specific driver approach already in the global registry.

Migration: build an idempotent importer from JSON into an inactive SQLite ledger. Acquire an exclusive repository migration/runtime lease and stop writers before cutover. Retain an untouched backup and verify identities, statuses, outputs, worker generations, and counts. Mark the new schema only after validation. For active legacy workflows without a stored definition, use a validated current-definition snapshot and record its migration provenance; unresolved cases remain blocked for inspection. Prevent old and new writers from running simultaneously through a supported rollout procedure. Do not dual-write two authoritative ledgers.

The global registry remains an eventually consistent index. Write projection events in the ledger transaction and replay them into the index idempotently. Index unavailability must not undo successful job execution.

Exit: two independent connections/processes cannot own one job attempt or violate a concurrency slot; stale completion cannot overwrite a newer attempt; interrupted import can restart; index rebuild reproduces execution views. Before new execution begins, rollback may restore the backup. After new effects occur, an old JSON backup is not a safe rollback: use forward repair or a verified lossless export.

### 5. Consolidate execution and separate it from discovery

Work: extract `PollTriggers`, `StartWorkflow`, `AdvanceWorkflow`, `ExecuteJob`, `ReconcileOperations`, and `ManageWorkers`. Route old and new workflow configuration through one engine. Reconcile persisted active runs even when polling fails or an item no longer matches. Introduce explicit action outcomes and use the new ledger ports.

Scheduling: use one scheduling implementation for CLI and dashboard, defaulting to 30-second trigger polling with per-binding due times. Prevent overlapping polls per binding. Keep slow source I/O and long external operations from blocking other triggers or active-run advancement. Use a bounded executor, prompt shutdown cancellation, persistent operation observation, and a defined coalescing policy after laptop sleep instead of replaying every missed poll.

Exit: an action chain completes after its ticket disappears from discovery; two local launch paths do not duplicate effects protected by a claim; restart reconnects to existing worker sessions; failures/timeouts/cancellation reach dependent jobs; independent branches can progress while an external operation runs. Uncertain external effects are visible instead of blindly retried.

### 6. Centralize input resolution and validation

Work: implement the common typed resolver and variable catalog; keep compatibility rendering behind the adapter; add preflight validation and a preview of resolved inputs using recorded or fixture trigger data. Ensure conditions and prompt inputs share the documented context.

Exit: ticket description reaches prompts; numbers/objects remain typed; missing fields identify their job and input path; undeclared dependencies are rejected; resumed/retried jobs reuse persisted upstream outputs. Existing template fixtures still render identically in compatibility mode.

### 7. Complete application composition and execution inspection

Work: introduce `RelayModule.register` and explicit provider tokens/factories if phase 1 validates Nest. Give each repository one long-lived configured runtime rather than recreating stateful clients every poll. Route Commander and existing dashboard handlers to application services. Preserve the current HTTP API while extracting its transport adapter. Keep help/version commands lightweight.

Add execution inspection to the CLI and dashboard: trigger occurrence, definition/plugin revision, dependency wait reasons, redacted resolved inputs, outputs, attempts, operation handles, retry eligibility, and actual cancellation status. Use correlated structured events with repository/run/job/attempt IDs. Provide a plugin test fixture workflow that requires no live Linear or Codex credentials.

Exit: polling, single-run commands, dashboard supervision, retry, attach, stop, and cleanup all use the same services. Normal shutdown closes owned clients without killing persistent workers unless requested. Node and compiled-release smoke tests cover more than `--help`.

### 8. Cut over and retire duplicated paths

Work: validate representative imported repositories in temporary directories; perform the controlled ledger cutover; remove old execution paths after compatibility coverage passes. Keep documented configuration/public-plugin adapters for the migration window. Update architecture diagrams, plugin authoring instructions, config migration examples, and recovery instructions.

Exit: root and package tests, type checks, dashboard checks/build, compiled artifact smoke tests, and migration/recovery scenarios pass. Verify an actual restarted local process uses the new implementation in a fixture project. No active-run data is silently discarded and adding a plugin does not require engine edits.

## Required recovery scenarios

1. Duplicate event across polls and across application restarts.
2. Process termination before claim, after claim, after external effect, and after outcome persistence.
3. Lease expiry followed by a stale attempt reporting completion.
4. Ticket leaves a matching set while its workflow is running; source temporarily unavailable.
5. Two application processes target the same repository and concurrency group.
6. Started dependency observed after its producer already completed.
7. Partial failure in a multi-worker action, preserving each target's result and invocation identity.
8. Retry with successful upstream outputs; workflow config edited during an active run.
9. Plugin package unavailable or incompatible during restart.
10. Laptop sleep, shutdown during polling, timed-out commands, and existing tmux/Codex reconnection.
11. Interrupted JSON import, unavailable global index, and repeated projection replay.

Use deterministic clocks, fake integration clients, temporary SQLite databases, and separate-process race/crash fixtures. Reserve real tmux/Codex smoke checks for the runtime adapters and use disposable projects. Tests must exercise postconditions, not only mocked method calls.

## First implementation slice

Start with phase 1 and the SDK/command-plugin portion of phases 2–3. Demonstrate one registered command trigger feeding two dependent actions through the existing engine in an isolated fixture. Verify that the second action receives the first action's recorded output through the compatibility context. Keep centralized typed expression resolution for phase 6, and persistence migration and live workflow behavior changes for their own reviewed changes.

## Framework references

- [Nest standalone application context](https://docs.nestjs.com/standalone-applications): local application composition and lifecycle without requiring an HTTP listener.
- [Nest custom providers](https://docs.nestjs.com/fundamentals/custom-providers): explicit tokens, factories, and test substitutions.

These document the composition approach, not compatibility with Relay's compiled Bun artifact. That remains an explicit phase-1 validation task.
