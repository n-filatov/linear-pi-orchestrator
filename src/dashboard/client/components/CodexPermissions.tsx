import { useEffect, useState } from "react";
import { Alert, Select, Stack, Switch, Text, Textarea } from "@mantine/core";
import { request } from "../api";

type Permissions = {
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvals?: "on-request" | "auto-review" | "never";
  networkAccess?: boolean;
  writableRoots?: string[];
};
export function CodexPermissions({ value, onChange }: { value?: Permissions; onChange: (value: Permissions) => void }) {
  const [automaticReview, setAutomaticReview] = useState(false);
  useEffect(() => {
    let active = true;
    request<{ automaticReview: boolean }>("/api/codex/permissions/capabilities").then((result) => {
      if (active) setAutomaticReview(result.automaticReview);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const sandbox = value?.sandbox ?? "workspace-write";
  const approvals = value?.approvals ?? (value ? "on-request" : "never");
  const update = (patch: Partial<Permissions>) => onChange({ ...value, sandbox, approvals, ...patch });
  return <Stack gap="xs">
    <Text fw={700}>Permissions</Text>
    <Text size="xs" c="dimmed">Applies to new sessions and all their follow-up prompts. Running sessions keep their settings.</Text>
    <Select label="Sandbox" value={sandbox} data={[
      { value: "read-only", label: "Read-only" },
      { value: "workspace-write", label: "Workspace write" },
      { value: "danger-full-access", label: "Full access" },
    ]} onChange={(selected) => {
      if (!selected) return;
      const next: Permissions = { ...value, approvals, sandbox: selected as Permissions["sandbox"] };
      if (selected !== "workspace-write") delete next.writableRoots;
      if (selected === "danger-full-access") delete next.networkAccess;
      onChange(next);
    }} />
    {sandbox === "danger-full-access" && <Alert color="yellow">Commands can access files and the network with your user’s permissions.</Alert>}
    <Select label="Approvals" value={approvals} data={[
      { value: "on-request", label: "Ask when needed" },
      ...(automaticReview || approvals === "auto-review" ? [{ value: "auto-review", label: "Automatic review", disabled: !automaticReview }] : []),
      { value: "never", label: "Never ask" },
    ]} onChange={(selected) => selected && update({ approvals: selected as Permissions["approvals"] })} />
    {approvals === "on-request" && <Text size="xs" c="dimmed">Requests appear in the running Relay dashboard. Unanswered requests are declined after 10 minutes.</Text>}
    {approvals === "auto-review" && !automaticReview && <Text size="xs" c="red">Automatic review support could not be confirmed. Update Codex or choose another approval mode.</Text>}
    {sandbox !== "danger-full-access" && <Switch label="Network access" checked={value?.networkAccess ?? false} onChange={(event) => update({ networkAccess: event.currentTarget.checked })} />}
    {sandbox === "workspace-write" && <Textarea label="Additional writable folders" description="Absolute paths, one per line." autosize minRows={2} value={(value?.writableRoots ?? []).join("\n")} onChange={(event) => update({ writableRoots: event.currentTarget.value ? event.currentTarget.value.split("\n") : [] })} onBlur={() => update({ writableRoots: (value?.writableRoots ?? []).map((path) => path.trim()).filter(Boolean) })} />}
  </Stack>;
}
