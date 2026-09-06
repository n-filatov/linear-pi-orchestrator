import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import type { ReactNode } from "react";
import type { ResourceState } from "../resource";

export const formatTime = (value?: string | number) =>
  value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Not recorded";
export const repositoryName = (project: {
  displayName?: string;
  root?: string;
  id?: string;
}) => project.displayName || project.root || project.id || "Unknown repository";
export function StatusBadge({ status = "unknown" }: { status?: string }) {
  const color = /failed|blocked|error|missing|not-installed/.test(status)
    ? "red"
    : /running|started|succeeded|healthy|ready/.test(status)
      ? "teal"
      : /pending|waiting|claimed|launching|provisioning/.test(status)
        ? "yellow"
        : "gray";
  return (
    <Badge color={color} variant="light" tt="none">
      {status}
    </Badge>
  );
}
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <Paper withBorder p="xl">
      <Stack align="center" gap="sm">
        <Title order={3}>{title}</Title>
        {children && (
          <Text c="dimmed" ta="center" size="sm">
            {children}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
export function ResourceFeedback({
  name,
  resource,
}: {
  name: string;
  resource: ResourceState<unknown> & { refresh: () => Promise<void> };
}) {
  if (resource.error)
    return (
      <Alert
        color="red"
        title={`${name}: ${resource.status === "stale" ? "showing stale data" : "unavailable"}`}
        role="alert"
      >
        <Group justify="space-between">
          <Text size="sm">
            {resource.error.message}
            {resource.refreshedAt
              ? ` Last success: ${formatTime(resource.refreshedAt)}.`
              : ""}
          </Text>
          <Button
            variant="light"
            color="red"
            size="xs"
            onClick={() => void resource.refresh()}
            loading={resource.refreshing}
          >
            Retry {name.toLowerCase()}
          </Button>
        </Group>
      </Alert>
    );
  if (resource.status === "loading")
    return (
      <Center p="md">
        <Group>
          <Loader size="sm" />
          <Text size="sm">Loading {name.toLowerCase()}…</Text>
        </Group>
      </Center>
    );
  return null;
}
export function DetailBlock({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  if (value === undefined || value === null) return null;
  return (
    <details className="execution-detail-block">
      <summary>{label}</summary>
      <pre>
        {JSON.stringify(
          value,
          (key, entry) =>
            /password|secret|token|authorization|api.?key/i.test(key)
              ? "[redacted]"
              : entry,
          2,
        )}
      </pre>
    </details>
  );
}
