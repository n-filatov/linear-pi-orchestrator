# Global dashboard endpoint contract

The client targets the global control-plane API below. It keeps compatibility
fallbacks for the repository-scoped endpoints currently served by `DashboardServer`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET/POST | `/api/projects` | List/register project folders |
| DELETE | `/api/projects/:folderId` | Unregister a folder |
| GET/POST | `/api/projects/:folderId/workflows` | List/create workflows |
| GET/PUT/DELETE | `/api/projects/:folderId/workflows/:workflowId` | Read/update/delete a workflow |
| POST | `/api/projects/:folderId/workflows/:workflowId/test` | Dry-run a workflow |
| GET/PUT | `/api/projects/:folderId/workflows/:workflowId/layout` | Read/write canvas layout |
| GET | `/api/projects/:folderId/catalog` | Plugin/node catalog with JSON Schemas |
| GET | `/api/executions?folderId=&status=` | Global execution list |
| GET | `/api/executions/:runId` | Execution detail and node state |
| POST | `/api/executions/:runId/retry` | Retry a run or selected jobs |
| GET | `/api/workers` | Global worker list |
| POST | `/api/workers/:workerId/send` | Send text to a worker |
| POST | `/api/workers/:workerId/exec` | Open/execute a worker pane |

The current server exposes `/api/workflows`, `/api/runs`, `/api/plugins`,
`/api/plugins/schemas` and `/api/config/json`; these are used until the global
routes are available.
