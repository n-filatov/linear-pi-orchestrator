import {
  Alert,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import type { Json, ProjectFolder } from "../api";
import {
  DetailBlock,
  EmptyState,
  repositoryName,
  StatusBadge,
} from "../components/shared";

export function Settings({
  project,
  config,
  plugins,
  catalog,
  onWorkflows,
  onRepositories,
}: {
  project?: ProjectFolder;
  config: Json;
  plugins: Json;
  catalog: Json;
  onWorkflows: () => void;
  onRepositories: () => void;
}) {
  if (!project)
    return (
      <EmptyState title="Choose a repository for settings">
        Select a named repository in the scope picker to inspect its
        configuration and plugin health.
      </EmptyState>
    );
  const entries = Array.isArray(plugins.referenced) ? plugins.referenced : [];
  const installed = Array.isArray(plugins.installed) ? plugins.installed : [];
  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Repository settings</Title>
        <Text c="dimmed" size="sm">
          {repositoryName(project)}
        </Text>
      </div>
      <Paper withBorder p="lg">
        <Stack gap="sm">
          <Group justify="space-between">
            <Text fw={600}>Configuration and source</Text>
            <StatusBadge status={project.configStatus || "unknown"} />
          </Group>
          <Text size="sm" className="break-text">
            {project.root}/.task-relay.yaml
          </Text>
          <Text size="sm" c="dimmed">
            Source configuration and plugin declarations are repository-owned.
            Edit these in YAML, then sync the configuration. Whole-file writes
            are unavailable in the global dashboard; workflow edits use
            revision-protected endpoints.
          </Text>
          <Group>
            <Button variant="light" onClick={onWorkflows}>
              Edit workflows
            </Button>
            <Button variant="default" onClick={onRepositories}>
              Repository controls
            </Button>
          </Group>
          <DetailBlock label="Source configuration" value={config.sources} />
          <DetailBlock
            label="Advanced configuration (read-only)"
            value={config}
          />
        </Stack>
      </Paper>
      {catalog.modelAvailability?.available === false && (
        <Alert color="yellow" title="Model catalog unavailable">
          {String(
            catalog.modelAvailability.error?.message ||
              "The model provider is unavailable",
          )}
          . Model fields accept configured values.
        </Alert>
      )}
      <Title order={3}>Referenced plugin health</Title>
      {entries.length ? (
        <Table.ScrollContainer minWidth={580}>
          <Table withTableBorder striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Plugin</Table.Th>
                <Table.Th>Kind</Table.Th>
                <Table.Th>Health</Table.Th>
                <Table.Th>Diagnostic</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((entry: any, index: number) => (
                <Table.Tr key={`${entry.kind}:${entry.use}:${index}`}>
                  <Table.Td>{entry.use}</Table.Td>
                  <Text component="td" size="sm">
                    {entry.kind || "Not recorded"}
                  </Text>
                  <Table.Td>
                    <StatusBadge
                      status={entry.state || entry.health || "unknown"}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c={entry.error ? "red" : "dimmed"}>
                      {entry.error ||
                        (entry.locations || []).join(", ") ||
                        "No diagnostic reported"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <EmptyState title="No plugin references reported" />
      )}
      <Title order={3}>Installed plugins</Title>
      {installed.map((entry: any, index: number) => (
        <Paper withBorder p="md" key={`${entry.use || entry.name}:${index}`}>
          <Group justify="space-between">
            <div>
              <Text fw={600}>
                {entry.use || entry.package || entry.name || entry.id}
              </Text>
              <Text size="xs" c="dimmed">
                {entry.version || "Version not reported"}
              </Text>
            </div>
            <StatusBadge status={entry.health || entry.state || "unknown"} />
          </Group>
          {entry.error && (
            <Text size="sm" c="red">
              {entry.error}
            </Text>
          )}
        </Paper>
      ))}
      {!installed.length && (
        <Text size="sm" c="dimmed">
          No installed plugins reported.
        </Text>
      )}
      <DetailBlock label="Advanced plugin catalog" value={catalog} />
    </Stack>
  );
}
