# Dashboard redesign handoff

Status: implemented and locally verified, 2026-09-06. Live activation pending.

## Delivered direction

The dashboard is organized around three daily surfaces: Work, Workflows, and
Repositories. Work groups historical source events into the newest actionable run
per repository/ticket; execution inspection opens contextually from that list.
The existing React Flow canvas and Relay engine remain in place; Mantine supplies
the application shell, forms, tables, dialogs, and shared feedback.

| Area | Responsibility |
| --- | --- |
| `src/dashboard/client/App.tsx` | Application shell, repository scope, navigation, resource composition, and editor leave protection. |
| pages | Work, Repositories, Workflows, and contextual execution detail. |
| work-items | Pure grouping rule: one latest actionable run per repository/ticket. |
| `src/dashboard/client/resource.ts` | Per-resource loading, stale-data retention, and protection from outdated scope responses. |
| `src/dashboard/client/api.ts` | Typed request failures, response validation, draft-preview and retry contracts. |
| `src/dashboard/client/components/shared.tsx` | Status, loading/error/empty feedback, and expandable technical detail. |
| `src/dashboard/client/theme.ts`, `dashboard.css` | Shared Mantine theme and dashboard/canvas layout. |
| `src/dashboard/global-server.ts`, `src/app.ts` | Validated in-memory workflow previews and selected-job retry eligibility. |

See `dashboard-design-spec.md` for the design direction and
`dashboard-redesign-plan.md` for user stories and acceptance criteria.

## Verification

An isolated headless Chrome profile serves the built dashboard with all API
requests intercepted by in-memory fixture responses. Tests simulate failures,
registration, watcher control, save conflicts, and retry requests without
touching registered repositories, credentials, real tickets, or active workers.
Browser artifacts are local review outputs rather than production screenshots.

- Automated suite: **315 tests across 62 files passed** (`npm test`).
- Type checks: `npm run check` and `npm run dashboard:check` passed.
- Build and architecture: `npm run dashboard:build` and `npm run boundaries` passed.
- Browser: **23 fixture journeys passed**, covering scoped watcher controls,
  registration validation, authentication errors, selected-job retry, URL filters,
  mobile navigation, initial/dirty workflow state, consecutive saves, conflicts,
  worker targeting, stale data, rapid scope changes, settings failure, rename/delete,
  external revisions, whole-draft preview, unsupported preview responses, loading
  Linear controls, invalid advanced JSON, and inline/file prompt exclusivity.
- Six-page rendered smoke inspection reported no browser runtime or console errors
  and no mutation requests. Desktop and narrow repository layouts were inspected.
- `git diff --check` passed.

The browser harness and screenshots are temporary local review artifacts in
`/private/tmp/relay-dashboard-review-v02ybT`, not a committed Playwright dependency
or a reproducible CI browser suite. Automated regression tests are included in the
repository changes under `test/`; no Git commit was created by this task. This verification
does not claim a full accessibility audit or authenticated live-server acceptance.

The existing automated suite uses disposable repositories and includes real
localhost server and temporary tmux integration tests. These need an environment
that allows localhost listeners and temporary processes. A sandbox `listen EPERM`
is an environment restriction, not a failing application assertion.

## Operational boundaries

- No live repository state migration, workflow activation, or dashboard-process
  restart is part of this handoff.
- Whole-repository source/plugin configuration remains file-based. Repository
  settings explain the YAML edit/sync path; workflow edits use revision-aware APIs.
- Vite reports its JavaScript chunk-size advisory (over 500 kB). Route-level
  splitting and a measured performance budget remain follow-up optimization work.
- Operational logging remains in the console; no separate Logs page was added.
- Draft preview assesses discovery and eligibility. It does not execute actions
  or guarantee that a future agent run will succeed.
- The new UI requires affirmative draft-preview support from the server and
  authoritative retry eligibility. An older running backend must not silently
  turn a draft preview into a saved preview or enable unsupported retry controls.

## Local rollout

1. Finish or preserve unsaved dashboard drafts. Inspect whether the current
   dashboard is supervising any repositories before scheduling a restart.
2. Run the documented checks and build from the intended checkout. Keep the last
   known working code/build available in a separate checkout or artifact; do not
   discard local changes to prepare rollback.
3. At the chosen restart point, stop only the identified dashboard process and
   start the updated one from that checkout:

   ```sh
   npm run dev:cli -- dashboard --port 3001
   ```

4. Open the authenticated URL printed by that process. A server restart changes
   its authentication token, so an old browser session may need reauthentication.
5. Verify the actual served UI, repository list, source/configuration state,
   execution inspection, and preview behavior. Check watcher state explicitly
   before deciding whether to restart polling; do not infer it from API connectivity.

Building the frontend alone does not update the backend already running in Node.
The dashboard serves build assets from disk, so build and process activation should
be coordinated for live use.

## Rollback

At a coordinated restart point, run the previous known working checkout/build
and reopen its newly printed authenticated URL. This UI change does not require
a reverse data migration. Keep any workflow YAML changes made after rollout and
review them separately; replacing the UI build must not restore old repository
files or erase execution history. Recheck watcher ownership and state afterward.
