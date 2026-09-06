import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Group,
  Pagination,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import * as api from "../api";
import type {
  ExecutionDetail,
  ExecutionInspection,
  ProjectFolder,
  WorkflowSummary,
} from "../api";
import type { DashboardRoute } from "../router";
import {
  DetailBlock,
  EmptyState,
  formatTime,
  repositoryName,
  ResourceFeedback,
  StatusBadge,
} from "../components/shared";
import { useResource } from "../resource";

export const executionStatuses = [
  "running",
  "started",
  "pending",
  "succeeded",
  "failed",
  "skipped",
  "omitted",
  "cancelled",
  "stopped",
  "claimed",
  "launching",
  "provisioning",
  "timed_out",
];
export function filterExecutions(
  runs: any[],
  filters: DashboardRoute["filters"] = {},
) {
  return runs.filter(
    (run) =>
      (!filters.status ||
        run.status === filters.status ||
        Object.values(run.jobs ?? {}).some(
          (job: any) => job.status === filters.status,
        )) &&
      (!filters.workflow ||
        (run.identity?.workflowId || run.workflowId) === filters.workflow) &&
      (!filters.ticket ||
        `${run.item?.id || ""} ${run.item?.title || ""} ${run.id}`
          .toLowerCase()
          .includes(filters.ticket.toLowerCase())),
  );
}
export function Executions({
  executions,
  workflows,
  projects,
  route,
  onRoute,
  onRefresh,
  minimal = false,
}: {
  executions: any[];
  workflows: WorkflowSummary[];
  projects: ProjectFolder[];
  route: DashboardRoute;
  onRoute: (route: DashboardRoute, replace?: boolean) => void;
  onRefresh: () => void;
  minimal?: boolean;
}) {
  const [page, setPage] = useState(1);
  const filters = route.filters ?? {};
  const visible = filterExecutions(executions, filters);
  useEffect(
    () => setPage(1),
    [filters.status, filters.workflow, filters.ticket, route.projectId],
  );
  const updateFilter = (
    name: keyof NonNullable<DashboardRoute["filters"]>,
    value: string | null,
  ) =>
    onRoute(
      { ...route, filters: { ...filters, [name]: value || undefined } },
      true,
    );
  const workflowOptions = [
    ...new Set([
      ...workflows.map((workflow) => workflow.id),
      ...executions
        .map((run) => run.identity?.workflowId || run.workflowId)
        .filter(Boolean),
    ]),
  ];
  if (minimal)
    return route.executionId ? (
      <ExecutionInspector
        key={route.executionId}
        id={route.executionId}
        projectId={route.projectId}
        onClose={() => onRoute({ page: "home", projectId: route.projectId })}
        onRefresh={onRefresh}
      />
    ) : null;
  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Executions</Title>
        <Text size="sm" c="dimmed">
          Inspect a job to understand its inputs, waits, outcome, and retry
          eligibility.
        </Text>
      </div>
      <Group grow align="flex-end">
        <Select
          label="Status or job status"
          placeholder="All statuses"
          clearable
          data={executionStatuses}
          value={filters.status || null}
          onChange={(value) => updateFilter("status", value)}
        />
        <Select
          label="Workflow"
          placeholder="All workflows"
          clearable
          data={workflowOptions}
          value={filters.workflow || null}
          onChange={(value) => updateFilter("workflow", value)}
        />
        <TextInput
          label="Ticket or execution"
          placeholder="Search ticket, title, or execution ID"
          value={filters.ticket || ""}
          onChange={(event) =>
            updateFilter("ticket", event.currentTarget.value)
          }
        />
      </Group>
      <Table.ScrollContainer minWidth={760}>
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Ticket</Table.Th>
              <Table.Th>Repository / workflow</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Updated</Table.Th>
              <Table.Th>Jobs</Table.Th>
              <Table.Th>Detail</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visible.slice((page - 1) * 30, page * 30).map((run) => {
              const owner = projects.find(
                (project) =>
                  project.id ===
                  (run.projectFolderId || run.folderId || run.projectId),
              );
              return (
                <Table.Tr key={run.id}>
                  <Table.Td>
                    <Text fw={600} size="sm">
                      {run.item?.id || run.id}
                    </Text>
                    <Text c="dimmed" size="xs" lineClamp={1}>
                      {run.item?.title}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {owner
                        ? repositoryName(owner)
                        : run.projectFolderId || "Unknown repository"}
                    </Text>
                    <Text c="dimmed" size="xs">
                      {run.identity?.workflowId || run.workflowId}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={run.status} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">
                      {formatTime(run.updatedAt || run.startedAt)}
                    </Text>
                  </Table.Td>
                  <Table.Td>{Object.keys(run.jobs ?? {}).length}</Table.Td>
                  <Table.Td>
                    <Button
                      variant="light"
                      size="xs"
                      aria-label={`Inspect execution ${run.item?.id || run.id}`}
                      onClick={() => onRoute({ ...route, executionId: run.id })}
                    >
                      Inspect
                    </Button>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {!visible.length && (
        <EmptyState title="No matching executions">
          Adjust the filters or wait for the next workflow execution.
        </EmptyState>
      )}
      {visible.length > 30 && (
        <Pagination
          total={Math.ceil(visible.length / 30)}
          value={Math.min(page, Math.ceil(visible.length / 30))}
          onChange={setPage}
        />
      )}
      {route.executionId && (
        <ExecutionInspector
          key={route.executionId}
          id={route.executionId}
          projectId={route.projectId}
          onClose={() => onRoute({ ...route, executionId: undefined })}
          onRefresh={onRefresh}
        />
      )}
    </Stack>
  );
}
function ExecutionInspector({
  id,
  projectId,
  onClose,
  onRefresh,
}: {
  id: string;
  projectId?: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const resource = useResource<ExecutionDetail>(
    `execution:${projectId || "all"}:${id}`,
    () => api.getExecution(id),
    5000,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const detail = resource.data;
  const owner = detail?.execution as any;
  const wrongScope =
    projectId && owner?.projectFolderId && owner.projectFolderId !== projectId;
  const execution: ExecutionInspection | undefined = !wrongScope
    ? (detail?.inspection ?? detail?.execution)
    : undefined;
  const jobs = execution?.jobs ?? detail?.jobs ?? {};
  const eligible = (id: string) =>
    Boolean(detail?.retryEligibility?.eligible.includes(id));
  const eligibleKey = (detail?.retryEligibility?.eligible ?? []).join("\u0000");
  useEffect(() => {
    setSelected((current) => current.filter((id) => eligible(id)));
  }, [eligibleKey]);
  const retry = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      await api.retryExecution(id, selected.filter(eligible));
      setSelected([]);
      await resource.refresh();
      onRefresh();
      setFeedback({
        error: false,
        text: "Selected jobs were submitted for retry. Refreshed execution state is shown below.",
      });
    } catch (error) {
      setFeedback({
        error: true,
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      opened
      onClose={onClose}
      position="right"
      size="lg"
      title={`Execution · ${execution?.item?.id || id}`}
      zIndex={250}
    >
      <Stack>
        <ResourceFeedback name="Execution detail" resource={resource} />
        {wrongScope && (
          <Alert color="red">
            This execution belongs to another repository. Select All
            repositories to inspect it.
          </Alert>
        )}
        {feedback && (
          <Alert
            color={feedback.error ? "red" : "teal"}
            role={feedback.error ? "alert" : "status"}
          >
            {feedback.text}
          </Alert>
        )}
        {execution && (
          <>
            <Group>
              <StatusBadge status={execution.status} />
              <Text size="sm">
                {execution.identity?.workflowId || execution.workflowId}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              Execution: {id}
              <br />
              Revision: {execution.definitionRevision || "Not recorded"} ·
              Updated: {formatTime(execution.updatedAt)}
            </Text>
            <Title order={3}>Jobs</Title>
            {!detail?.retryEligibility && (
              <Alert color="yellow">
                This server does not report authoritative retry eligibility.
                Update the dashboard server before retrying jobs here.
              </Alert>
            )}
            <Paper withBorder p="md">
              <Stack gap="xs">
                <Text size="sm">
                  Retry only the selected failed jobs in this execution.
                  Completed jobs remain unchanged. The server validates
                  eligibility again before retry.
                </Text>
                <Button
                  onClick={() => void retry()}
                  loading={busy}
                  disabled={!selected.length || Boolean(resource.error)}
                >{`Retry selected jobs (${selected.length})`}</Button>
              </Stack>
            </Paper>
            {Object.entries(jobs).map(([jobId, raw]) => (
              <Paper withBorder p="md" key={jobId}>
                <Stack gap="xs">
                  <Group justify="space-between">
                    <Checkbox
                      label={jobId}
                      aria-label={`Select ${jobId} for retry`}
                      checked={selected.includes(jobId)}
                      disabled={!eligible(jobId) || busy}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelected((current) =>
                          checked
                            ? [...current, jobId]
                            : current.filter((value) => value !== jobId),
                        );
                      }}
                    />
                    <StatusBadge status={raw.status} />
                  </Group>
                  {Boolean(
                    execution.decisions?.[jobId]?.reason ||
                      raw.waitReason ||
                      raw.message ||
                      raw.error,
                  ) && (
                    <Text
                      size="sm"
                      c={raw.status === "failed" ? "red" : "dimmed"}
                    >
                      {String(
                        raw.error ||
                          raw.message ||
                          raw.waitReason ||
                          execution.decisions?.[jobId]?.reason,
                      )}
                    </Text>
                  )}
                  {raw.needsAttention && (
                    <Alert color="yellow">
                      The previous operation has an uncertain outcome. Inspect
                      its external state before retrying.
                    </Alert>
                  )}
                  <Text size="xs" c="dimmed">
                    Retry:{" "}
                    {eligible(jobId)
                      ? "failed job; server will validate"
                      : raw.needsAttention
                        ? "manual review required"
                        : detail?.retryEligibility?.ineligible.find(
                            (entry) => entry.id === jobId,
                          )?.reason || "eligibility unavailable"}
                    {raw.retryAt
                      ? ` · scheduled retry ${formatTime(raw.retryAt)}`
                      : ""}
                  </Text>
                  {Boolean(raw.workerId) && (
                    <Text size="xs" c="dimmed">
                      Worker: {String(raw.workerId)}
                    </Text>
                  )}
                  <DetailBlock
                    label="Attempts"
                    value={raw.attempts ?? raw.attempt ?? raw.attemptId}
                  />
                  <DetailBlock
                    label="Resolved input (secrets redacted)"
                    value={raw.resolvedInput ?? raw.input ?? raw.inputs}
                  />
                  <DetailBlock
                    label="Output"
                    value={raw.output ?? raw.outputs}
                  />
                  <DetailBlock
                    label="Operation"
                    value={raw.operation ?? raw.operationHandle}
                  />
                </Stack>
              </Paper>
            ))}
            {!Object.keys(jobs).length && (
              <EmptyState title="No recorded jobs" />
            )}
            <DetailBlock
              label="Plugin revisions"
              value={execution.pluginRevisions}
            />
            <DetailBlock
              label="Trigger payload"
              value={execution.trigger ?? execution.item}
            />
            <DetailBlock label="Recent events" value={detail?.events} />
          </>
        )}
      </Stack>
    </Drawer>
  );
}
