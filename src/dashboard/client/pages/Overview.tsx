import {
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import type { ProjectFolder } from "../api";
import { ArrowRight } from "lucide-react";
import {
  EmptyState,
  formatTime,
  repositoryName,
  StatusBadge,
} from "../components/shared";
import { isWaiting, type WorkRun, workItems } from "../work-items";

export function Overview({
  executions,
  projects,
  scope,
  onExecution,
  onWorkflows,
}: {
  executions: WorkRun[];
  projects: ProjectFolder[];
  scope?: ProjectFolder;
  onExecution: (id: string) => void;
  onWorkflows: () => void;
}) {
  const items = workItems(executions);
  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Overview</Title>
        <Text c="dimmed" size="sm">
          {scope ? repositoryName(scope) : "All repositories"} · latest
          workflow activity and work that needs your attention
        </Text>
      </div>
      <div className="overview-metrics">
        {[
          ["Executions", executions.length],
          ["Failed executions", executions.filter((run) => run.status === "failed").length],
          ["Failure rate", executions.length ? `${Math.round(executions.filter((run) => run.status === "failed").length / executions.length * 100)}%` : "—"],
          ["Needs attention", items.length],
          ["Repositories", scope ? 1 : projects.length],
        ].map(([label, value]) => <div key={label}><Text size="sm" c="dimmed">{label}</Text><Text className="metric-value">{value}</Text></div>)}
      </div>
      <Group className="overview-section" justify="space-between">
        <Text fw={600}>Work requiring attention</Text>
        <Button variant="default" onClick={onWorkflows} rightSection={<ArrowRight size={16} aria-hidden />}>Open workflows</Button>
      </Group>
      {!items.length ? (
        <EmptyState title="No work needs attention">
          Review workflows or wait for the next matching ticket change.
          <Button mt="sm" variant="light" onClick={onWorkflows}>
            Review workflows
          </Button>
        </EmptyState>
      ) : (
        <Stack gap="sm">
          {items.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              projects={projects}
              onInspect={onExecution}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function RunCard({
  run,
  projects,
  onInspect,
}: {
  run: WorkRun;
  projects: ProjectFolder[];
  onInspect: (id: string) => void;
}) {
  const project = projects.find(
    (candidate) =>
      candidate.id === (run.projectFolderId || run.folderId || run.projectId),
  );
  const reason = Object.values(run.jobs ?? {}).find(
    (job) => job.error || job.message || job.waitReason,
  );
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" wrap="nowrap">
        <div className="min-width-zero">
          <Group gap="xs">
            <Text fw={600}>{run.item?.id || run.id}</Text>
            <StatusBadge status={run.status} />
            {isWaiting(run) && run.status !== "failed" && (
              <Badge color="orange" variant="light">
                waiting
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed" lineClamp={1}>
            {run.item?.title ||
              run.identity?.workflowId ||
              run.workflowId ||
              "Workflow run"}
          </Text>
          <Text size="xs" c="dimmed">
            {project
              ? repositoryName(project)
              : run.projectFolderId || "Unknown repository"}{" "}
            · updated {formatTime(run.updatedAt || run.startedAt)}
          </Text>
          {reason && (
            <Text
              size="xs"
              c={run.status === "failed" ? "red" : "orange"}
              lineClamp={1}
            >
              {String(reason.error || reason.message || reason.waitReason)}
            </Text>
          )}
        </div>
        <Button size="xs" variant="light" onClick={() => onInspect(run.id)}>
          Inspect
        </Button>
      </Group>
    </Paper>
  );
}
