# Dashboard implementation design

Status: implemented Mantine direction, simplified to the three daily work
surfaces on 2026-09-06.
The examples below are wireframes with illustrative data, not live repository state.

## Product direction

Task Relay helps a developer configure automated work and understand its progress.
Every screen should make its repository scope, data freshness, and next useful
action clear. Use a restrained dark theme with a single accent, consistent Mantine
controls, readable status labels, and compact tables for comparison.

Maintain separate meanings for dashboard connection, repository configuration,
watcher activity, enabled workflow, execution state, and worker state. A successful
fetch is not evidence that a watcher is running. An enabled workflow is not evidence
that an agent is active. Registration validates configuration but does not start polling.

## Shared layout

- Persistent navigation: Work, Workflows, and Repositories. Execution details
  open contextually from Work; worker, plugin, and source diagnostics are not
  daily navigation destinations.
- Searchable scope selector: All repositories or a named repository. A selected
  repository is a local browser preference and is restored for Work and Workflows;
  selecting All repositories clears it.
- Repositories is global. Editing workflows/settings requires a selected repository.
- Header: page title, clear scope, contextual primary action, and refresh state.
- Show last successful refresh. Keep last known data on refresh failure and label
  it stale. First-load failure has its own message and retry action.
- Keep form errors adjacent to their fields and operation errors near the action.
- Use repository links and explicit row actions rather than nesting buttons in a
  clickable container. Preserve keyboard access and focus across polling updates.
- Replace browser prompts/alerts with labelled Mantine overlays or inline feedback.

## Repositories wireframe

```text
┌──────────────────┬─────────────────────────────────────────────────────┐
│ Task Relay       │ Repositories                         Add repository │
│                  │ All registered folders · updated just now          │
│ All repositories │                                                     │
│                  │ Search repositories…                               │
│ Overview         │                                                     │
│ Repositories     │ Repository     Config  Watcher  Last poll  Actions  │
│ Workflows        │ payments-api   Valid   Running  12:01     Stop  …   │
│ Executions       │ /work/payments                                      │
│ Workers          │ website        Valid   Stopped  —         Start …  │
│ Settings         │ /work/website                                       │
│                  │                                                     │
│ Refresh status   │ Select a repository to configure its workflows.    │
└──────────────────┴─────────────────────────────────────────────────────┘
```

Add repository opens one dialog with a folder path field, inline validation, and
Add repository / Cancel actions. Explain that the folder needs Relay configuration.
Keep the entered path after failure. Resolve successful registration to the new scope.

Watcher actions show the repository destination. Starting polling can process
eligible work immediately. Stopping polling must not claim to stop existing agents.
Block duplicate submissions. Show a returned blocked/failed state as such, with
the cause and recovery guidance. Unregister remains a secondary action and explains
that it removes registration rather than deleting repository files.

Variants: no repositories with Add repository action; search with no results;
loading skeleton; unavailable listing with Retry; stale last-known rows; invalid
configuration; blocked watcher with full reason; pending per-row action.

## Workflow editor wireframe

```text
┌───────────────┬────────────────────────────────────────────────────────┐
│ Workflow list │ Implement ticket   Enabled · Unsaved    Preview Save …│
│ Search…       ├────────────────────────────────┬───────────────────────┤
│ + Create      │                                │ Send prompt           │
│               │ Ticket matched                 │ Display name          │
│ Implement     │       ↓                        │ Session selector      │
│ Review        │ Start worker                   │ Saved prompt selector │
│ Cleanup       │       ↓                        │ Model / effort        │
│               │ Start session → Send prompt    │ Advanced settings     │
│               │                                │                       │
│               │ + Add action                   │ Preview action        │
│               │ Zoom / fit / undo              │ Edit JSON             │
├───────────────┴────────────────────────────────┴───────────────────────┤
│ Preview of current draft · Eligibility only                           │
│ ENG-123   Implement eligible   Review waiting for dependency           │
└───────────────────────────────────────────────────────────────────────┘
```

Keep React Flow for graph interaction. Use a consistent right panel for node
configuration. Display ordering dependencies separately from session/worker
references so two prompts can share a session while running in sequence.

Create workflow offers Agent task, Cleanup, and Blank templates. Template selection
must be explicit. Present required fields first and engine-specific details under
advanced settings. Preserve unknown configuration fields through edits.

Save states: saved, unsaved, saving, conflict, failed, and configuration saved with
layout failure. Conflicts preserve the draft and explain how to reload intentionally.
Guard navigation and workflow switching when unsaved changes would be lost.

Preview states: pending, eligible results, no matches, provider failure, and results
stale after edits. Always identify draft versus saved revision. Preview is discovery
and eligibility assessment, not an executed action. Never imply a real run succeeded.

Advanced JSON editing maintains invalid intermediate text, validates on application,
and permits cancelling without mutating the node. Prompt files remain repository-owned.

## Execution detail wireframe

```text
┌──────────────────────────────────────┬────────────────────────────────┐
│ Executions                           │ ENG-123                    Close│
│ Repository Workflow Status Search   │ payments-api / Implement       │
│                                      │ Failed · updated 12:03         │
│ ENG-123 Implement Failed 12:03       │                                │
│ ENG-124 Implement Started 12:04      │ Start worker       Succeeded   │
│                                      │ Start session      Succeeded   │
│                                      │ Send prompt        Failed      │
│                                      │ Reason: …                      │
│                                      │ Attempts / Inputs / Outputs    │
│                                      │ Worker link                    │
│                                      │                                │
│                                      │ Selected job: Send prompt      │
│                                      │ Retry selected job             │
└──────────────────────────────────────┴────────────────────────────────┘
```

The detail has a stable URL and shows its repository, workflow, ticket, and definition
revision. Expose job status, wait reason, attempts, redacted inputs/outputs, and
operation information. Expand technical detail only when requested.

Retry names the target jobs and respects server-side eligibility. Manual-review
states explain why retry is unavailable. An accepted retry does not imply success;
show the refreshed execution state. Do not steal focus as details refresh.

Filters survive refresh and browser navigation. Include the complete relevant engine
status vocabulary rather than dropping started, skipped, or omitted states. Show
repository identity in global lists.

## Work and advanced detail

Work is the default screen. It groups historical source events into one newest
actionable run per repository/ticket, removing decorative counters and duplicate
cards. Inspect opens retry-safe execution detail in context; worker identifiers
remain visible in that detail but standalone worker controls are not part of the
daily dashboard.

Source/plugin diagnostics and raw advanced configuration remain implementation
capabilities, not navigation destinations. Preserve the visual workflow editor and
supported revision-aware writes. Do not add an unsafe whole-file overwrite fallback.

## Responsive and accessibility criteria

- At 1280/1440 pixels, primary actions and editor context remain visible.
- On narrow screens, collapse navigation into an accessible menu and retain the
  scope selector. Tables may scroll inside their container, not widen the document.
- Render node/execution inspectors as overlays when side-by-side space is limited.
- Accessible names for icon controls; visible focus; labelled fields and errors;
  Escape and focus return for overlays; status meaning must not rely only on color.
- Native browser reload protection can be used for dirty drafts; in-app navigation
  uses an accessible confirmation surface.

## Verification approach

Use disposable fixtures and a separate browser profile for screenshots and interaction
checks. Do not authenticate into a personal browser profile or exercise active worker
controls as a test. Verify actual served build assets, not source-only output. Record
UI limitations and the distinction between fixture verification and live activation.
