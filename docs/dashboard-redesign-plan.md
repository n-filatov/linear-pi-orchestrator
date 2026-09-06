# Dashboard redesign and Mantine work plan

Status: implemented and locally verified. Coordinated live activation remains pending;
see `dashboard-redesign-handoff.md` for verification and rollout boundaries.

Date: 2026-09-06

## Outcome

Help a developer register a repository, configure an agent workflow, preview its
behavior, monitor execution, and recover a failed job with clear scope and state.

The design direction covers three screens: Repositories, Workflow Editor,
and Execution Detail. The user's subsequent request to implement this plan
supersedes the initial design-only approval checkpoint. See
`docs/dashboard-design-spec.md` for the implementation design specification.

## Review baseline

- The React client already uses Mantine for some inputs and React Flow for the canvas.
- Repository registration and watcher controls, workflow editing, action previews,
  execution inspection, and worker controls exist in the source.
- The API supports selected-job retry; the current UI exposes run-level retry.
- Workflow preview uses saved configuration; action preview can use a draft.
- Broad API fallbacks can obscure errors, and some status labels are static.
- The supplied dashboard URL returned HTTP 401 to the review session. Its live
  appearance and authenticated interactions have not been verified.
- Coordinate with `docs/local-architecture-refactoring-plan.md`; this redesign
  must not initiate a storage migration or duplicate the application extraction.

## Scope and boundaries

Preserve the workflow engine, CLI behavior, YAML configuration semantics,
repository-owned prompt files, graph semantics, existing sessions, and persisted
execution history. Retain React Flow and extend the existing Mantine adoption.

Keep the existing common action palette for the first release. Expanded plugin
authoring, an in-browser terminal, prompt-file editing, a separate operational
logs page, storage migration, and a new scheduler are outside this plan.

Implementation can add narrowly scoped API behavior where the journeys require
it. Those changes need explicit contracts and separate acceptance criteria.
An API change must not silently broaden an action from one repository to all.

## User stories and traceability

| ID | Developer story | Work item |
| --- | --- | --- |
| US-01 | Register a repository and see whether it is ready for automation. | DASH-03 |
| US-02 | Configure source filters and understand which tickets qualify. | DASH-04, DASH-05 |
| US-03 | Connect actions in the intended order and select the correct worker/session. | DASH-04 |
| US-04 | Select saved prompts and configure model/effort on prompt steps. | DASH-04 |
| US-05 | Preserve unsaved edits and know which revision is saved or previewed. | DASH-04, DASH-05 |
| US-06 | Find active, waiting, and failing work in the intended repository scope. | DASH-02, DASH-06 |
| US-07 | Inspect a failed job and retry an eligible step. | DASH-06 |
| US-08 | Identify and interact with the intended worker. | DASH-07 |
| US-09 | Understand plugin availability and configuration failures. | DASH-07 |

## Proposed navigation

- Overview: attention items, active work, and links to relevant executions.
- Repositories: explicitly global repository management.
- Workflows: workflow list and editor in the selected scope.
- Executions: execution list and addressable execution detail.
- Workers: worker inventory and interaction controls.
- Repository settings: source/configuration information and plugin diagnostics.

Use an explicit “All repositories” option and named repository options. Require
a repository for authoring. Show the selected scope in the header, filters, and
action destination. Preserve existing deep links through compatible routes or
redirects, including the current Plugins page.

## Work items, in delivery order

### DASH-00 — Design and interaction specification

Dependencies: none. Priority: first.

Deliverables:

- Authenticated inspection of the existing dashboard when access is available,
  without starting watchers or triggering live workflows.
- Wireframes/mockups for Repositories, Workflow Editor, and Execution Detail.
- Navigation, terminology, spacing, typography, status colors, and action hierarchy.
- Loading, empty, stale, error, permission/session-expired, and unsaved variants.
- A walkthrough: register → configure → preview → save → observe → inspect → retry.

Acceptance:

- The three screens follow the implementation design specification; the user
  reviews the delivered interface. The later implementation request authorizes
  proceeding without a second design approval.
- Mock data is labelled; unverified live behavior is recorded explicitly.
- The design distinguishes watcher state, workflow enabled state, execution
  state, and worker state; it also distinguishes stopping polling from cleanup.
- Desktop layout works at 1280 and 1440 pixels; a narrow layout keeps scope and
  essential controls accessible. Canvas editing remains primarily desktop-oriented.

### DASH-01 — Shared Mantine foundation

Dependencies: DASH-00 design specification and the subsequent implementation authorization.

Deliverables:

- Extract page components from `src/dashboard/client/App.tsx` with behavior preserved.
- Centralize theme tokens and introduce shared page headers, status badges,
  loading/error/empty states, dialogs, and notifications.
- Use Mantine AppShell, navigation, controls, and overlays; preserve React Flow.
- Migrate global CSS incrementally and use scoped styles for canvas-specific visuals.
- Add only the Mantine packages actually needed, at compatible versions.

Acceptance:

- Existing routes and actions remain available during the migration.
- Keyboard focus, dialog escape/close behavior, accessible names, and dropdown
  layering work in the browser, including over the canvas.
- Structural extraction and behavior changes are independently reviewable.

### DASH-02 — Reliable scope and data state

Dependencies: DASH-01.

Deliverables:

- Explicit global/repository scope and route-driven selection.
- Typed resource state with loading, success, empty, stale, and error outcomes.
- API errors retain status and context; only verified compatibility cases fall back.
- Discard or cancel requests from a previous repository after scope changes.
- Display last successful refresh and derive connectivity from actual responses.
- Refresh watcher status alongside relevant operational data; allow per-resource retry.

Acceptance:

- 401, server failure, or timeout never becomes “no executions” or “watcher stopped.”
- Rapid repository switching cannot display or save another repository's data.
- A failed resource does not erase unrelated successful data.
- Deep links, reload, browser back/forward, and missing-resource states work.
- Global lists identify the owning repository for each item.

### DASH-03 — Repositories and onboarding

Dependencies: DASH-02.

Deliverables:

- One Add repository dialog with inline validation.
- Searchable repository table showing configuration, watcher, last poll, and
  active execution count where supported by current data.
- Contextual Start watcher / Stop watcher controls and a secondary actions menu.
- Registration, config sync, watcher startup, and unregister feedback in context.
- A readiness view pointing to the next necessary setup step.

Acceptance:

- Valid registration resolves to the intended repository; invalid input stays in the form.
- Starting a watcher may begin processing configured work; this is clear before activation.
- Stop watcher is not presented as stopping existing agents.
- Blocked startup shows the server's reason and an actionable next step.
- Unregister explains effects on supervision and registration accurately; it is
  not labelled as deleting repository files.
- Success is shown after the response and relevant state refresh.

### DASH-04 — Workflow authoring and draft safety

Dependencies: DASH-02 and the approved editor design; follow DASH-03 for delivery.

Deliverables:

- Searchable workflow list and explicit Agent task / Cleanup / Blank creation choice.
- Toolbar with name, enabled state, dirty state, Preview, Save, and secondary menu.
- Consistent Mantine node forms and an advanced JSON editor that preserves
  incomplete text and reports validation errors.
- Searchable prompt-file and reference pickers; model/effort on prompt steps.
- Distinct presentation for execution dependencies and worker/session references.
- Navigation protection and external-revision conflict handling that preserve drafts.
- Advanced workflow settings for supported scheduling, concurrency, retry, and
  timeout fields, with unsupported fields preserved through round trips.

Acceptance:

- Create, duplicate, rename, save, and delete work in the selected repository.
- Workflow switching and refresh do not silently discard edits.
- Cycle/dangling-reference errors identify the affected nodes.
- Multiple prompts can target one session while retaining independent ordering.
- Existing workflows preserve unknown plugin fields and engine semantics on save.
- Configuration and layout persistence failures are reported separately.
- Save controls prevent duplicate submissions; conflicts do not overwrite external edits.

### DASH-05 — Consistent preview behavior

Dependencies: DASH-04.

Deliverables:

- Define the preview contract for both workflow and selected action.
- Prefer validated in-memory draft preview with structured eligibility results.
- Display whether the preview concerns the current draft or a saved revision.
- Show matched tickets, eligible actions, and concrete blocking/wait reasons.
- Mark preview results stale after draft changes and guard against late responses.

Acceptance:

- Preview does not save configuration, claim tickets, start agents, or clean workers.
- Whole-workflow and action previews have consistent draft semantics.
- Until draft-wide preview exists, the UI explicitly requires saving or labels
  the operation “Preview saved workflow”; it must not imply the draft was tested.
- A successful eligibility preview does not imply the action itself executed successfully.
- Provider errors remain errors, and empty matches are a distinct successful result.

### DASH-06 — Overview, executions, and recovery

Dependencies: DASH-02; deliver after DASH-05.

Deliverables:

- Overview focused on failures, blocked watchers, waiting jobs, and active work.
- Execution filters for repository, workflow, status, and ticket with URL persistence.
- Addressable execution detail with job state, waits, attempts, redacted inputs,
  outputs, and links to the relevant worker.
- Selected-job retry using the existing API, with authoritative eligibility rules.

Acceptance:

- A developer can reach a failed job and its reason directly from Overview.
- Filtering covers actual engine states, including started, skipped, and omitted.
- Retry scope is visible; the server validates eligibility rather than trusting a badge.
- A retry request produces an updated result or a specific error and does not
  unnecessarily replay completed work.
- Refresh retains the inspected run and keyboard focus; large result sets remain usable.

### DASH-07 — Worker controls and settings

Dependencies: DASH-06.

Deliverables:

- Worker details show repository, ticket, execution, workspace, and session identifiers.
- Replace browser prompts with labelled interaction dialogs and destination summaries.
- Distinguish sending terminal text from executing a command in a pane.
- Move plugin/configuration diagnostics into the approved settings navigation,
  maintaining existing links and advanced access.

Acceptance:

- Worker actions display their target and capability before submission.
- Terminal text is not described as a guaranteed Codex API prompt.
- Plugin health comes from actual data; unavailable capabilities explain their limits.
- Configuration writes preserve revision protection and existing plugin fields.

### DASH-08 — Integration verification and handoff

Dependencies: DASH-03 through DASH-07.

Deliverables:

- Run type checks, dashboard build, and relevant existing automated coverage.
- Exercise the complete journey in a disposable repository with fixture providers
  or controlled stub actions; do not use real issues or active workers as test targets.
- Browser checks for normal and failure states, keyboard operation, responsive
  layout, canvas interactions, session expiry, and saved-state restoration.
- Update dashboard endpoint documentation and developer setup notes.
- Record remaining limitations and a rollout/rollback procedure based on verified
  build artifacts, with no data migrations required for the UI change.

Acceptance:

- The developer stories above pass or have explicitly accepted limitations.
- Existing workflow and CLI compatibility checks remain green.
- Verify the actual served build in the browser; source checks alone are insufficient.
- Activation against live repositories is a separate, coordinated rollout step
  because restarting a dashboard can affect its supervised polling.

## API work to resolve before dependent implementation

| Capability | Current starting point | Planned decision |
| --- | --- | --- |
| Draft workflow preview | Saved workflow preview and draft action preview | Add a validated draft contract and structured results in DASH-05. |
| Retry selected jobs | Existing jobIds API | Verify eligibility enforcement and expose it clearly in DASH-06. |
| Health/freshness | Supervisor status and normal resource requests | Derive available state first; add fields only for a documented gap. |
| Prompt content preview | Prompt-file listing | Optional follow-up; first release requires selection and error reporting only. |
| List scaling | Existing lists and some server filters | Use current scope/filter support first; add server pagination if representative volumes require it. |
| Source/settings editing | Configuration APIs | Use existing revision-aware paths; avoid introducing a competing configuration store. |

## Verification commands and relevant coverage

Use the repository's existing commands, selecting tests according to each change:

```sh
npm run check
npm run dashboard:check
npm run dashboard:build
npx vitest run test/dashboard-client-router.test.ts test/dashboard-client-graph.test.ts
npx vitest run test/global-dashboard.test.ts test/dashboard.test.ts test/workflow-config-repository.test.ts
git diff --check
```

For workflow/recovery API changes, also run relevant workflow and recovery tests.
Run import-boundary checks when moving code across package boundaries. Complete
the full suite at integration handoff where the environment supports its required
listeners/processes; report environment restrictions separately from test failures.

## Delivery checkpoints

| Checkpoint | Included work | Review outcome |
| --- | --- | --- |
| Design | DASH-00 | Approve three screens, terminology, and interactions. |
| First usable slice | DASH-01–03 | Register and operate a repository with reliable scope and feedback. |
| Authoring | DASH-04–05 | Build, preserve, preview, and save a workflow predictably. |
| Operations | DASH-06–07 | Diagnose a run and interact with the correct worker. |
| Handoff | DASH-08 | Verify compatibility and prepare the live rollout. |

Each work item should be a small reviewable change or a short series of changes.
Do not combine the redesign with the storage migration or an engine rewrite.
Estimate implementation effort after DASH-00 and the preview/eligibility contract
checks; those are the main unresolved scope drivers.
