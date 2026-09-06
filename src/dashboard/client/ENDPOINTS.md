# Global dashboard endpoint contract

The client targets the global control-plane API below. Repository-scoped
requests remain scoped: an authentication, server, or timeout error is surfaced
to the caller and is never replaced by a global request or an empty result.
Requests use a 15-second AbortController timeout by default; callers may pass a
different timeout to the client request helper.
Successful responses must be valid JSON with the documented collection shape;
malformed bodies return a client-side `ApiError` with status `502`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET/POST | `/api/projects` | List/register project folders |
| DELETE | `/api/projects/:folderId` | Unregister a folder |
| GET/POST | `/api/projects/:folderId/workflows` | List/create workflows |
| GET/PUT/DELETE | `/api/projects/:folderId/workflows/:workflowId` | Read/update/delete a workflow |
| POST | `/api/projects/:folderId/workflows/:workflowId/test` | Dry-run a saved workflow; include `{workflow}` for a validated in-memory draft preview |
| GET/PUT | `/api/projects/:folderId/workflows/:workflowId/layout` | Read/write canvas layout |
| GET | `/api/projects/:folderId/catalog` | Plugin/node catalog with JSON Schemas |
| GET | `/api/executions?folderId=&status=` | Global execution list |
| GET | `/api/executions/:runId` | Execution detail, node state, and authoritative `retryEligibility` |
| POST | `/api/executions/:runId/retry` | Retry only failed (or legacy `timed_out`) jobs; `{jobIds}` selects jobs |
| GET | `/api/workers` | Global worker list |
| POST | `/api/workers/:workerId/send` | Send text to a worker |
| POST | `/api/workers/:workerId/exec` | Open/execute a worker pane |

The current single-repository server exposes `/api/workflows`, `/api/runs`,
`/api/plugins`, `/api/plugins/schemas` and `/api/config/json`; those routes are
used only when no repository scope is selected. A scoped request does not fall
back to them. Whole-config writes for the global server return `501`; workflow
writes use the revision-aware workflow endpoints instead.

## Preview responses

Both action and draft previews are read-only and return `dryRun: true` with
structured eligibility rows. Empty matches are successful responses with
`triggerMatchCount: 0`; provider or validation failures are error responses.
The draft form is `{ workflow: <draft definition or graph> }` and returns a
`WorkflowTestResult` with per-item `jobs` decisions. The draft is validated in
memory and is never written to repository YAML.

Repository catalog responses may include `modelAvailability: { available,
models?, error? }`. A missing or failed Codex model probe is therefore visible
without making the whole plugin catalog look unavailable.

## Retry eligibility

The dashboard retry endpoint is narrower than the low-level store operation.
The server reports `retryEligibility` and only permits jobs whose persisted
status is `failed` or the historical `timed_out` marker. `succeeded`,
`skipped`, `omitted`, `pending`, and `started` jobs are not replayed. Jobs marked
`needsAttention` require manual inspection and remain blocked. A run-level retry
selects only eligible jobs; a future `retryAt` remains authoritative and blocks
manual replay until that time. If none are eligible the endpoint returns `409`.
