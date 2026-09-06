import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Modal, Paper, SegmentedControl, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { Copy, FileText, Plus, Save, Search } from "lucide-react";
import Markdown from "react-markdown";
import * as api from "../api";
import { useResource } from "../resource";
import { ResourceFeedback } from "../components/shared";

function usesPrompt(value: unknown, path: string): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "promptFile" && typeof child === "string" && child.replace(/^\.\//, "") === path || usesPrompt(child, path));
}

export function Prompts({ project, onWorkflow, onDirtyChange, onBusyChange }: {
  project: api.ProjectFolder;
  onWorkflow: (id: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const library = useResource(`prompts:${project.id}`, () => api.getPrompts(project), 10000);
  const workflows = useResource(`prompt-uses:${project.id}`, () => api.getWorkflows(project), 10000);
  const [prompt, setPrompt] = useState<api.EditablePrompt>();
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<() => void>();
  const [creating, setCreating] = useState<{ content: string }>();
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState("");
  const dirty = Boolean(prompt && prompt.content !== content);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  const working = (value: boolean) => { setBusy(value); onBusyChange(value); };
  const guard = (action: () => void) => dirty ? setPending(() => action) : action();
  const open = async (path: string) => {
    working(true); setError(""); setNotice("");
    try { const next = await api.getPrompt(project, path); setPrompt(next); setContent(next.content); }
    catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally { working(false); }
  };
  const save = async () => {
    if (!prompt) return;
    working(true); setError(""); setNotice("");
    try { const next = await api.savePrompt(project, prompt.path, content, prompt.revision); setPrompt(next); setNotice("Prompt saved."); await library.refresh(); }
    catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally { working(false); }
  };
  const create = async () => {
    if (!creating || !name.trim()) return;
    const filename = /\.(md|txt)$/i.test(name.trim()) ? name.trim() : `${name.trim()}.md`;
    working(true); setCreateError("");
    try {
      const next = await api.savePrompt(project, `.task-relay/prompts/${filename}`, creating.content, null);
      setPrompt(next); setContent(next.content); setMode("edit"); setCreating(undefined); setError(""); setNotice("Prompt created."); await library.refresh();
    } catch (error) { setCreateError(String(error instanceof Error ? error.message : error)); }
    finally { working(false); }
  };
  return <Stack gap="lg">
    <Group justify="space-between">
      <div><Title order={2}>Prompts</Title><Text c="dimmed" size="sm">Repository instructions stored in .task-relay/prompts</Text></div>
      <Button leftSection={<Plus size={16} />} disabled={busy} onClick={() => guard(() => { setName(""); setCreateError(""); setCreating({ content: "" }); })}>New prompt</Button>
    </Group>
    <ResourceFeedback name="Prompts" resource={library} />
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {notice && <Alert color="teal" role="status">{notice}</Alert>}
    <div className="prompt-layout">
      <Paper withBorder p="md"><Stack gap="sm">
        <TextInput aria-label="Search prompts" placeholder="Search prompts" leftSection={<Search size={16} />} value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        {(library.data?.prompts ?? []).filter((path) => path.toLowerCase().includes(query.toLowerCase())).map((path) => <Button key={path} variant={prompt?.path === path ? "light" : "subtle"} color={prompt?.path === path ? "orange" : "gray"} justify="flex-start" leftSection={<FileText size={16} />} disabled={busy} onClick={() => guard(() => void open(path))} title={path}>{path.replace(/^\.task-relay\/prompts\//, "")}</Button>)}
        {library.data && !library.data.prompts.length && <Text c="dimmed" size="sm">No prompts yet. Create your first prompt to use it in a workflow.</Text>}
      </Stack></Paper>
      <Paper withBorder p="lg" className="min-width-zero">
        {prompt ? <Stack>
          <Group justify="space-between"><Text fw={600} className="break-text">{prompt.path.replace(/^\.task-relay\/prompts\//, "")}</Text><Badge color={dirty ? "orange" : "teal"}>{dirty ? "Unsaved changes" : "Saved"}</Badge></Group>
          <Group justify="space-between">
            <SegmentedControl aria-label="Prompt view" value={mode} onChange={setMode} data={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />
            <Group gap="xs">
              <Button variant="default" disabled={busy} onClick={() => guard(() => void open(prompt.path))}>Reload</Button>
              <Button variant="default" leftSection={<Copy size={16} />} disabled={busy} onClick={() => { setName(prompt.path.replace(/^\.task-relay\/prompts\//, "").replace(/\.(md|txt)$/i, "-copy.$1")); setCreateError(""); setCreating({ content }); }}>Duplicate</Button>
              <Button leftSection={<Save size={16} />} loading={busy} disabled={!dirty} onClick={() => void save()}>Save</Button>
            </Group>
          </Group>
          {mode === "edit" ? <Textarea aria-label="Prompt content" value={content} onChange={(event) => setContent(event.currentTarget.value)} disabled={busy} autosize minRows={18} styles={{ input: { fontFamily: "ui-monospace, monospace", fontSize: 13 } }} /> : <div className="prompt-preview"><Markdown skipHtml components={{ img: ({ alt }) => <span>[Image: {alt}]</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{content}</Markdown></div>}
          <Text size="sm" fw={600}>Used by</Text>
          <ResourceFeedback name="Workflow references" resource={workflows} />
          <Group>{(workflows.data ?? []).filter((workflow) => usesPrompt(workflow, prompt.path)).map((workflow) => <Button key={workflow.id} variant="light" onClick={() => onWorkflow(workflow.id)} disabled={busy}>{workflow.id}</Button>)}</Group>
          {workflows.data && !workflows.data.some((workflow) => usesPrompt(workflow, prompt.path)) && <Text size="sm" c="dimmed">No workflows reference this prompt yet. Select it in a workflow node’s Saved prompt field.</Text>}
        </Stack> : <Stack align="center" py={80}><FileText size={36} color="#999" /><Text c="dimmed">Select a prompt to edit or preview it.</Text></Stack>}
      </Paper>
    </div>
    <Modal opened={Boolean(creating)} onClose={() => !busy && setCreating(undefined)} title="New prompt" closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy}>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}><Stack>
        <TextInput autoFocus label="File name" description="Saved inside .task-relay/prompts. The .md extension is added automatically." placeholder="review-code" value={name} onChange={(event) => setName(event.currentTarget.value)} disabled={busy} required />
        {createError && <Alert color="red">{createError}</Alert>}
        <Button type="submit" loading={busy} disabled={!name.trim()}>Create prompt</Button>
      </Stack></form>
    </Modal>
    <Modal opened={Boolean(pending)} onClose={() => setPending(undefined)} title="Unsaved prompt changes"><Stack><Text>Discard your unsaved changes and continue?</Text><Group justify="flex-end"><Button variant="default" onClick={() => setPending(undefined)}>Keep editing</Button><Button color="red" onClick={() => { const action = pending; setPending(undefined); action?.(); }}>Discard changes</Button></Group></Stack></Modal>
  </Stack>;
}
