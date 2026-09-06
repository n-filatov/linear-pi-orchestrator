import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import * as api from "../api";
import type { ProjectFolder, Worker } from "../api";
import {
  DetailBlock,
  EmptyState,
  repositoryName,
  StatusBadge,
} from "../components/shared";

export function Workers({
  workers,
  projects,
  project,
  selectedWorkerId,
  onRefresh,
}: {
  workers: Worker[];
  projects: ProjectFolder[];
  project?: ProjectFolder;
  selectedWorkerId?: string;
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState(selectedWorkerId || "");
  const [target, setTarget] = useState<{
    worker: Worker;
    action: "send" | "exec";
  }>();
  const [text, setText] = useState("");
  const [submit, setSubmit] = useState(true);
  const [open, setOpen] = useState("pane");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const owner = (worker: Worker) =>
    projects.find(
      (candidate) =>
        candidate.id === worker.projectFolderId ||
        candidate.root === worker.repository?.root ||
        candidate.id === worker.repository?.id,
    );
  const visible = workers.filter((worker) =>
    JSON.stringify([
      worker.id,
      worker.issueKey,
      worker.itemId,
      worker.title,
      worker.workspacePath,
    ])
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const canControl = (worker: Worker) =>
    Boolean(
      worker.runtime?.tmuxPane ||
        worker.runtime?.tmuxSession ||
        worker.snapshot?.harness?.sessionId,
    ) &&
    !["cleaned", "processes_stopped", "workspace_removing", "stopped"].includes(
      worker.status || "",
    );
  const control = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!target || !text.trim() || busy) return;
    const destination = owner(target.worker) || project;
    if (!destination) {
      setFeedback({
        error: true,
        text: "This worker's repository is not registered. Register it before interacting.",
      });
      return;
    }
    setBusy(true);
    setFeedback(undefined);
    try {
      await api.controlWorker(
        target.worker.id,
        target.action,
        target.action === "send" ? { text, submit } : { command: text, open },
        destination,
      );
      setTarget(undefined);
      setText("");
      onRefresh();
      setFeedback({
        error: false,
        text: `${target.action === "send" ? "Terminal text sent" : "Command submitted"} to worker ${target.worker.id}.`,
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
    <Stack gap="lg">
      <div>
        <Title order={2}>Workers</Title>
        <Text size="sm" c="dimmed">
          Identify the repository, ticket, workspace, and terminal before
          interacting.
        </Text>
      </div>
      {feedback && (
        <Alert
          color={feedback.error ? "red" : "teal"}
          role={feedback.error ? "alert" : "status"}
        >
          {feedback.text}
        </Alert>
      )}
      <TextInput
        label="Find worker"
        placeholder="Worker ID, ticket, or workspace"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      <Table.ScrollContainer minWidth={760}>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Worker / ticket</Table.Th>
              <Table.Th>Repository / workspace</Table.Th>
              <Table.Th>State</Table.Th>
              <Table.Th>Interactions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visible.map((worker) => (
              <Table.Tr key={worker.id}>
                <Table.Td>
                  <Text fw={600} size="sm">
                    {worker.issueKey ||
                      worker.itemId ||
                      worker.task ||
                      "No ticket"}
                  </Text>
                  <Text size="xs" c="dimmed" className="break-text">
                    {worker.id}
                  </Text>
                  <Text size="xs">
                    Execution: {worker.runId || "Not recorded"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">
                    {owner(worker)
                      ? repositoryName(owner(worker)!)
                      : worker.repository?.root || "Unknown repository"}
                  </Text>
                  <Text size="xs" c="dimmed" className="break-text">
                    {worker.workspacePath ||
                      worker.workspace?.path ||
                      "Workspace not recorded"}
                  </Text>
                  <DetailBlock
                    label="Session identifiers"
                    value={worker.runtime || worker.snapshot?.harness}
                  />
                </Table.Td>
                <Table.Td>
                  <StatusBadge status={worker.status} />
                </Table.Td>
                <Table.Td>
                  <Stack gap="xs">
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="light"
                        disabled={!canControl(worker)}
                        onClick={() => {
                          setTarget({ worker, action: "send" });
                          setText("");
                          setFeedback(undefined);
                        }}
                      >
                        Send terminal text
                      </Button>
                      <Button
                        size="xs"
                        variant="default"
                        disabled={!canControl(worker)}
                        onClick={() => {
                          setTarget({ worker, action: "exec" });
                          setText("");
                          setFeedback(undefined);
                        }}
                      >
                        Execute command
                      </Button>
                    </Group>
                    {!canControl(worker) && (
                      <Text size="xs" c="dimmed">
                        No active terminal capability recorded.
                      </Text>
                    )}
                  </Stack>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {!visible.length && (
        <EmptyState title="No matching workers">
          Workers appear after a workflow starts them.
        </EmptyState>
      )}
      <Modal
        opened={Boolean(target)}
        onClose={() => !busy && setTarget(undefined)}
        title={
          target?.action === "send" ? "Send terminal text" : "Execute a command"
        }
        closeOnEscape={!busy}
        closeOnClickOutside={!busy}
        withCloseButton={!busy}
      >
        <form onSubmit={(event) => void control(event)}>
          <Stack>
            <Paper withBorder p="sm">
              <Text size="sm" fw={600}>
                {target &&
                  (owner(target.worker)
                    ? repositoryName(owner(target.worker)!)
                    : target.worker.repository?.root)}
              </Text>
              <Text size="xs" className="break-text">
                Worker: {target?.worker.id}
                <br />
                Ticket: {target?.worker.issueKey || target?.worker.itemId}
                <br />
                Session: {target?.worker.runtime?.tmuxSession ||
                  "Not recorded"}{" "}
                · Pane: {target?.worker.runtime?.tmuxPane || "Not recorded"}
              </Text>
            </Paper>
            <Text size="sm" c="dimmed">
              {target?.action === "send"
                ? "Text is typed into the worker's terminal. The receiving program determines how it is interpreted; this is not a Codex API prompt."
                : "Execute a shell command in a new terminal pane or window associated with this worker."}
            </Text>
            <Textarea
              data-autofocus
              label={
                target?.action === "send" ? "Terminal text" : "Shell command"
              }
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
              autosize
              minRows={4}
              required
              disabled={busy}
            />
            {target?.action === "send" ? (
              <Checkbox
                label="Press Enter after sending"
                checked={submit}
                onChange={(event) => setSubmit(event.currentTarget.checked)}
              />
            ) : (
              <Select
                label="Open command in"
                data={[
                  { value: "pane", label: "New pane" },
                  { value: "window", label: "New window" },
                ]}
                value={open}
                onChange={(value) => setOpen(value || "pane")}
              />
            )}
            {feedback?.error && <Alert color="red">{feedback.text}</Alert>}
            <Group justify="flex-end">
              <Button
                variant="default"
                disabled={busy}
                onClick={() => setTarget(undefined)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!text.trim()}>
                {target?.action === "send" ? "Send text" : "Execute command"}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
