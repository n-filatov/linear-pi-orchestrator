import { useState } from "react";
import { Alert, Button, Code, Group, Stack, Text } from "@mantine/core";
import { request } from "../api";
import { useResource } from "../resource";

type Approval = { id: string; workerId: string; repositoryRoot: string; method: string; params: Record<string, unknown>; expiresAt: string };
const load = async () => (await request<{ approvals: Approval[] }>("/api/codex/approvals")).approvals;
export function CodexApprovals() {
  const resource = useResource("codex-approvals", load, 2000);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const respond = async (id: string, decision: "accept" | "decline") => {
    setBusy(id); setError(undefined);
    try {
      await request(`/api/codex/approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ decision }) });
      await resource.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(undefined); }
  };
  if (resource.error) return <Alert color="red" title="Approval queue unavailable">{resource.error.message}</Alert>;
  if (!resource.data?.length && !error) return null;
  return <Stack gap="xs">
    {error && <Alert color="red">{error}</Alert>}
    {resource.data?.map((approval) => <Alert key={approval.id} color="yellow" title="Codex needs approval">
      <Stack gap="xs">
        <Text size="sm">{approval.repositoryRoot} · {approval.workerId}</Text>
        <Text size="sm">{approval.method === "item/commandExecution/requestApproval" ? "Run command" : approval.method === "item/fileChange/requestApproval" ? "Change files" : "Grant permissions for this turn"}</Text>
        <Code block style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }}>{JSON.stringify(approval.params, null, 2)}</Code>
        <Text size="xs">Declines automatically at {new Date(approval.expiresAt).toLocaleTimeString()}.</Text>
        <Group>
          <Button loading={busy === approval.id} disabled={Boolean(busy)} onClick={() => void respond(approval.id, "accept")}>Allow once</Button>
          <Button variant="default" disabled={Boolean(busy)} onClick={() => void respond(approval.id, "decline")}>Decline</Button>
        </Group>
      </Stack>
    </Alert>)}
  </Stack>;
}
