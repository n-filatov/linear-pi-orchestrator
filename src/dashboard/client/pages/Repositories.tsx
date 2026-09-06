import { useState } from "react";
import {
  Alert,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import * as api from "../api";
import type { ProjectFolder } from "../api";
import {
  EmptyState,
  formatTime,
  repositoryName,
  StatusBadge,
} from "../components/shared";

export function RegisterDialog({
  opened,
  onClose,
  onAdded,
}: {
  opened: boolean;
  onClose: () => void;
  onAdded: (project: ProjectFolder) => Promise<void>;
}) {
  const [root, setRoot] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!root.trim()) {
      setError("Enter a repository folder path.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const project = await api.registerProject(root.trim());
      await onAdded(project);
      setRoot("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Add repository"
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      withCloseButton={!busy}
    >
      <form onSubmit={(event) => void submit(event)}>
        <Stack>
          <Text size="sm" c="dimmed">
            Register a local repository. Its YAML remains the source of
            configuration. Starting its watcher is a separate action.
          </Text>
          <TextInput
            data-autofocus
            label="Repository folder path"
            placeholder="/path/to/repository"
            value={root}
            onChange={(event) => setRoot(event.currentTarget.value)}
            error={error || undefined}
            disabled={busy}
            required
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Register repository
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function Repositories({
  projects,
  executions,
  onSelect,
  onRefresh,
  onAdd,
  onRemoved,
}: {
  projects: ProjectFolder[];
  executions: any[];
  onSelect: (project: ProjectFolder) => void;
  onRefresh: () => Promise<void>;
  onAdd: () => void;
  onRemoved: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [action, setAction] = useState<{
    project: ProjectFolder;
    kind: "start" | "stop" | "remove";
  }>();
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const control = async (
    project: ProjectFolder,
    kind: "start" | "stop" | "sync" | "remove",
  ) => {
    setBusy(project.id);
    setFeedback(undefined);
    try {
      if (kind === "remove") {
        await api.removeProject(project);
        onRemoved(project.id);
      } else {
        const result = await api.controlProject(project, kind);
        if (
          result.status?.error ||
          ["failed", "blocked"].includes(result.status?.state)
        )
          throw new Error(
            result.status.error ||
              `Watcher is ${result.status.state}. Check configuration in Repository settings.`,
          );
      }
      await onRefresh();
      setAction(undefined);
      setFeedback({
        error: false,
        text: `${repositoryName(project)}: ${kind === "remove" ? "unregistered" : kind === "sync" ? "configuration synchronized" : kind === "start" ? "watcher started" : "watcher stopped"}.`,
      });
    } catch (error) {
      setFeedback({
        error: true,
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy("");
    }
  };
  const visible = projects.filter((project) =>
    `${repositoryName(project)} ${project.root}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <div>
          <Title order={2}>Registered repositories</Title>
          <Text size="sm" c="dimmed">
            Global inventory · watcher controls affect the named repository.
          </Text>
        </div>
        <Button onClick={onAdd}>Add repository</Button>
      </Group>
      {feedback && (
        <Alert
          color={feedback.error ? "red" : "teal"}
          role={feedback.error ? "alert" : "status"}
          withCloseButton
          onClose={() => setFeedback(undefined)}
        >
          {feedback.text}
        </Alert>
      )}
      <TextInput
        aria-label="Search repositories"
        placeholder="Search repositories or paths"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      {projects.length ? (
        <Table.ScrollContainer minWidth={850}>
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Repository</Table.Th>
                <Table.Th>Configuration</Table.Th>
                <Table.Th>Watcher</Table.Th>
                <Table.Th>Last poll</Table.Th>
                <Table.Th>Active executions</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visible.map((project) => {
                const watcher = project.watcher;
                const active = executions.filter(
                  (run) =>
                    (run.projectFolderId === project.id ||
                      run.folderId === project.id ||
                      run.projectId === project.id) &&
                    ["running", "started", "pending"].includes(run.status),
                ).length;
                return (
                  <Table.Tr key={project.id}>
                    <Table.Td>
                      <Button
                        variant="subtle"
                        px={0}
                        onClick={() => onSelect(project)}
                      >
                        {repositoryName(project)}
                      </Button>
                      <Text size="xs" c="dimmed" className="break-text">
                        {project.root}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={project.configStatus || "unknown"} />
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={watcher?.state || "unknown"} />
                      {watcher?.error && (
                        <Text size="xs" c="red">
                          {watcher.error}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{formatTime(watcher?.lastTickAt)}</Text>
                    </Table.Td>
                    <Table.Td>{active}</Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Button
                          size="xs"
                          variant="light"
                          disabled={!watcher || Boolean(busy)}
                          onClick={() =>
                            setAction({
                              project,
                              kind:
                                watcher?.state === "running" ? "stop" : "start",
                            })
                          }
                        >
                          {watcher?.state === "running"
                            ? "Stop watcher"
                            : "Start watcher"}
                        </Button>
                        <Menu withinPortal>
                          <Menu.Target>
                            <Button
                              size="xs"
                              variant="default"
                              aria-label={`More actions for ${repositoryName(project)}`}
                              disabled={Boolean(busy)}
                            >
                              •••
                            </Button>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              onClick={() => void control(project, "sync")}
                            >
                              Sync configuration
                            </Menu.Item>
                            <Menu.Item onClick={() => onSelect(project)}>
                              Open repository
                            </Menu.Item>
                            <Menu.Divider />
                            <Menu.Item
                              color="red"
                              onClick={() =>
                                setAction({ project, kind: "remove" })
                              }
                            >
                              Unregister repository
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <EmptyState title="Add your first repository">
          Register a folder, review its workflows, then start its watcher.
        </EmptyState>
      )}
      {projects.length > 0 && !visible.length && (
        <Text c="dimmed">No repositories match this search.</Text>
      )}
      <Modal
        opened={Boolean(action)}
        onClose={() => !busy && setAction(undefined)}
        title={
          action?.kind === "remove"
            ? "Unregister repository"
            : action?.kind === "start"
              ? "Start watcher"
              : "Stop watcher"
        }
        closeOnEscape={!busy}
        closeOnClickOutside={!busy}
        withCloseButton={!busy}
      >
        <Stack>
          <Text fw={600}>{action && repositoryName(action.project)}</Text>
          <Text size="sm">
            {action?.kind === "start"
              ? "Starting the watcher begins polling and may immediately process work through enabled workflows, including launching agents."
              : action?.kind === "stop"
                ? "This stops repository polling and closes dashboard-managed Codex connections. Worker workspaces and tmux sessions are not cleaned up."
                : "This stops supervision, closes managed Codex connections, and removes the repository from the global index. Repository files and worker workspaces are not deleted."}
          </Text>
          {feedback?.error && <Alert color="red">{feedback.text}</Alert>}
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => setAction(undefined)}
              disabled={Boolean(busy)}
            >
              Cancel
            </Button>
            <Button
              color={action?.kind === "remove" ? "red" : undefined}
              loading={Boolean(busy)}
              onClick={() =>
                action && void control(action.project, action.kind)
              }
            >
              {action?.kind === "remove"
                ? "Unregister"
                : action?.kind === "start"
                  ? "Start watcher"
                  : "Stop watcher"}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
