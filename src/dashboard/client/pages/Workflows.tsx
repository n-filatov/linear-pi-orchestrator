import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Zap, Terminal, Bot, Send, BrushCleaning, Plus, ArrowLeft, ArrowRight, Ellipsis, FlaskConical, Search, Save } from "lucide-react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  Divider,
  Drawer,
  Group,
  Menu,
  Modal,
  MultiSelect,
  Select,
  Paper,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from "@mantine/core";
import {
  ReactFlow,
  Background,
  Controls,
  ReactFlowProvider,
  Handle,
  Position,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import type {
  ActionTestResult,
  Json,
  ProjectFolder,
  WorkflowSummary,
  WorkflowTestResult,
} from "../api";
import * as api from "../api";
import {
  actionReferenceFor,
  actionReferenceValue,
  autoLayout,
  findDanglingActionReferences,
  findDanglingEdges,
  graphToWorkflow,
  setActionReference,
  syncActionReferenceEdge,
  upstreamReferenceNodes,
  wouldCycle,
  workflowToGraph,
  type GraphNode,
  type GraphNodeData,
} from "../graph";
import { setPromptInput, templateFor } from "../workflow-templates";

const CANVAS_ACTION_USES = [
  "tmux.create-window",
  "codex.start-session",
  "codex.send-prompt",
  "cleanup",
] as const;
const canvasActionUses = new Set<string>(CANVAS_ACTION_USES);
type CatalogEntry = {
  kind?: string;
  use?: string;
  schema?: Json;
  configSchema?: Json;
  matchSchema?: Json;
  presentation?: { name?: string; description?: string; category?: string };
  health?: string;
  configured?: boolean;
};
type WorkflowDraft = {
  base: WorkflowSummary;
  nodes: GraphNode[];
  edges: Edge[];
  viewport: Viewport;
  dirty: boolean;
};

export type WorkflowsProps = {
  workflows: WorkflowSummary[];
  config: Json;
  catalog: Json;
  project?: ProjectFolder;
  selectedWorkflowId?: string;
  onSelectWorkflow: (id?: string) => void;
  onSaved: (config: Json) => void;
  /** Lets the shell block page changes without deciding how to present that guard. */
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
};

function catalogEntries(catalog: Json): CatalogEntry[] {
  if (Array.isArray(catalog.entries)) return catalog.entries as CatalogEntry[];
  const entries =
    catalog.schemas && typeof catalog.schemas === "object"
      ? Object.values(catalog.schemas)
      : Object.values(catalog);
  return entries.filter((entry): entry is CatalogEntry =>
    Boolean(entry && typeof entry === "object"),
  );
}
function entrySchema(entry?: CatalogEntry, kind?: string): Json | undefined {
  return kind === "source"
    ? (entry?.matchSchema ?? entry?.schema ?? entry?.configSchema)
    : (entry?.schema ?? entry?.configSchema);
}
function labelFor(use = "action") {
  return (
    (
      {
        "tmux.create-window": "Start tmux window",
        "codex.start-session": "Start Codex session",
        "codex.send-prompt": "Send Codex prompt",
        cleanup: "Cleanup",
      } as Record<string, string>
    )[use] ?? use
  );
}
function entryLabel(entry: CatalogEntry) {
  return entry.presentation?.name && entry.presentation.name !== entry.use
    ? entry.presentation.name
    : labelFor(entry.use);
}
const statusClass = (status?: string) =>
  `status status-${String(status ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z]/g, "-")}`;

function TriggerNode({ data, selected }: NodeProps<GraphNode>) {
  return (
    <div className={`flow-node trigger-node ${selected ? "selected" : ""}`}>
      <Handle type="source" position={Position.Right} />
      <Zap className="node-symbol" size={44} strokeWidth={1.7} aria-hidden />
      <strong>{data.label}</strong>
      <small>{data.use || "source"} trigger</small>
    </div>
  );
}
function ActionNode({ data, selected }: NodeProps<GraphNode>) {
  const Icon = data.use === "tmux.create-window" ? Terminal : data.use === "cleanup" ? BrushCleaning : data.use === "codex.send-prompt" ? Send : Bot;
  return (
    <div className={`flow-node action-node ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <Icon className="node-symbol" size={40} strokeWidth={1.7} aria-hidden />
      <strong>{labelFor(data.use)}</strong>
      <small>{data.label}</small>
      {data.status && (
        <span className={statusClass(data.status)}>{data.status}</span>
      )}
    </div>
  );
}
const nodeTypes = { trigger: TriggerNode, action: ActionNode };

function sourceFor(config: Json) {
  return Object.keys(config.sources ?? {})[0];
}
export function Workflows(props: WorkflowsProps) {
  const {
    workflows,
    config,
    catalog,
    project,
    selectedWorkflowId,
    onSelectWorkflow,
    onSaved,
    onDirtyChange,
    onBusyChange,
  } = props;
  const [selected, setSelected] = useState(
    selectedWorkflowId ?? "",
  );
  const [drafts, setDrafts] = useState<Record<string, WorkflowDraft>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [persistenceWarning, setPersistenceWarning] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const reportBusy = useCallback(
    (busy: boolean) => {
      setEditorBusy(busy);
      onBusyChange?.(busy);
    },
    [onBusyChange],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [template, setTemplate] = useState<"agent" | "cleanup" | "blank">(
    "agent",
  );
  const [newName, setNewName] = useState("agent-task");
  const [createError, setCreateError] = useState("");
  const dirty = Object.values(drafts).some((draft) => draft.dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if ((selectedWorkflowId ?? "") !== selected)
      setSelected(selectedWorkflowId ?? "");
  }, [selected, selectedWorkflowId, workflows]);
  // The shell owns route changes and may refuse them while a different draft is
  // dirty. Do not show a different editor until it confirms the route change.
  const choose = (id?: string) => onSelectWorkflow(id);
  const create = () => {
    const id = newName.trim();
    if (!/^[a-zA-Z0-9._:-]+$/.test(id))
      return setCreateError("Use letters, numbers, '.', '_', ':' or '-'.");
    if (workflows.some((workflow) => workflow.id === id) || drafts[id])
      return setCreateError("A workflow with this ID already exists.");
    const base = templateFor(template, id, config);
    if (!base) return;
    choose(id);
    setDrafts((current) => ({
      ...current,
      [id]: {
        base,
        ...workflowToGraph(base),
        viewport: { x: 0, y: 0, zoom: 1 },
        dirty: true,
      },
    }));
    setCreateError("");
    setCreateOpen(false);
  };
  const summary =
    workflows.find((workflow) => workflow.id === selected) ??
    drafts[selected]?.base;
  const current = summary
    ? ({
        ...(config.workflows?.[selected] ?? {}),
        ...summary,
        id: selected,
      } as WorkflowSummary)
    : undefined;
  const updateDraft = (id: string, draft: WorkflowDraft) =>
    setDrafts((currentDrafts) => ({ ...currentDrafts, [id]: draft }));
  const saved = (next: Json, oldId: string, nextId?: string) => {
    setDrafts((currentDrafts) => {
      const { [oldId]: _, ...rest } = currentDrafts;
      return rest;
    });
    const destination = nextId ?? (next.workflows?.[oldId] ? oldId : Object.keys(next.workflows ?? {})[0]);
    setSelected(destination ?? "");
    choose(destination);
    onSaved(next);
  };
  const list = [...workflows].sort((a, b) => a.id.localeCompare(b.id));
  const [query, setQuery] = useState("");
  const visible = list.filter((workflow) =>
    workflow.id.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className={`workflow-layout ${selectedWorkflowId ? "workflow-detail" : "workflow-index"}`}>
      <aside className="workflow-list" inert={editorBusy}>
        {persistenceWarning && (
          <Alert
            color="yellow"
            withCloseButton
            onClose={() => setPersistenceWarning("")}
          >
            {persistenceWarning}
          </Alert>
        )}
        <Stack gap="xs">
          <Group justify="space-between">
            <div><Text className="workflow-page-title" fw={700}>Workflows</Text><Text size="sm" c="dimmed">Build and manage your repository automations</Text></div>
            <Button leftSection={<Plus size={17} aria-hidden />} onClick={() => setCreateOpen(true)}>
              Create workflow
            </Button>
          </Group>
          <TextInput
            size="xs"
            aria-label="Search workflows"
            placeholder="Search workflows"
            leftSection={<Search size={16} aria-hidden />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </Stack>
        {visible.map((workflow) => (
          <button
            key={workflow.id}
            className={
              workflow.id === selected
                ? "workflow-item selected"
                : "workflow-item"
            }
            onClick={() => choose(workflow.id)}
          >
            <span className={`workflow-status ${workflow.enabled === false ? "disabled" : ""}`} />
            <span>
              <b>{workflow.id}</b>
              <small>
                {Object.keys(workflow.jobs ?? {}).length} {Object.keys(workflow.jobs ?? {}).length === 1 ? "step" : "steps"} ·{" "}
                {workflow.enabled === false ? "disabled" : "enabled"}
                {drafts[workflow.id]?.dirty ? " · unsaved" : ""}
              </small>
            </span>
            <ArrowRight className="workflow-row-arrow" size={19} aria-hidden />
          </button>
        ))}
        {Object.values(drafts)
          .filter(
            (draft) =>
              !workflows.some((workflow) => workflow.id === draft.base.id),
          )
          .map((draft) => (
            <button
              key={draft.base.id}
              className={
                draft.base.id === selected
                  ? "workflow-item selected"
                  : "workflow-item"
              }
              onClick={() => choose(draft.base.id)}
            >
              <span className="workflow-status" />
              <span>
                <b>{draft.base.id}</b>
                <small>unsaved draft</small>
              </span>
            </button>
          ))}
        {!visible.length && (
          <Text c="dimmed" size="sm">
            No workflows found.
          </Text>
        )}
      </aside>
      {selectedWorkflowId && <div className="editor-navigation"><Button variant="subtle" color="gray" leftSection={<ArrowLeft size={16} aria-hidden />} onClick={() => choose(undefined)}>Workflows</Button><span>Editor</span><Text size="xs" c="dimmed">Select a node to configure it</Text></div>}
      {selectedWorkflowId && (current ? (
        <WorkflowEditor
          key={`${current.id}:${drafts[current.id]?.base.revision ?? current.revision ?? "new"}:${reloadKey}`}
          workflow={current}
          config={config}
          catalog={catalog}
          project={project}
          initialDraft={drafts[current.id]}
          onDraftChange={(draft) => updateDraft(current.id, draft)}
          onSaved={saved}
          onBusyChange={reportBusy}
          onPersistenceWarning={setPersistenceWarning}
          onReloadSaved={() => {
            setDrafts((previous) => {
              const { [current.id]: discarded, ...rest } = previous;
              return rest;
            });
            setReloadKey((value) => value + 1);
            onSaved(config);
          }}
        />
      ) : (
        <Stack align="center" justify="center" className="editor-empty">
          <Text fw={700}>
            {selectedWorkflowId
              ? `Workflow '${selectedWorkflowId}' was not found.`
              : "Select a workflow"}
          </Text>
          <Button onClick={() => setCreateOpen(true)}>Create workflow</Button>
        </Stack>
      ))}
      <Modal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create workflow"
        centered
      >
        <Stack>
          <Select
            label="Template"
            data={[
              {
                value: "agent",
                label: "Agent task — tmux, Codex session, prompt",
              },
              {
                value: "cleanup",
                label: "Cleanup — stop owned workers for completed work",
              },
              { value: "blank", label: "Blank — source trigger only" },
            ]}
            value={template}
            onChange={(value) =>
              setTemplate((value ?? "agent") as typeof template)
            }
          />
          <TextInput
            label="Workflow ID"
            value={newName}
            onChange={(event) => setNewName(event.currentTarget.value)}
            error={
              createError ||
              (newName && !/^[a-zA-Z0-9._:-]+$/.test(newName)
                ? "Use letters, numbers, '.', '_', ':' or '-'."
                : undefined)
            }
          />
          <Text size="xs" c="dimmed">
            New workflows use the first configured source.{" "}
            {sourceFor(config)
              ? `Source: ${sourceFor(config)}`
              : "Configure a source first."}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={create}
              disabled={!sourceFor(config) || !newName.trim()}
            >
              Create draft
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

function WorkflowEditor({
  workflow,
  config,
  catalog,
  project,
  initialDraft,
  onDraftChange,
  onSaved,
  onReloadSaved,
  onBusyChange,
  onPersistenceWarning,
}: {
  workflow: WorkflowSummary;
  config: Json;
  catalog: Json;
  project?: ProjectFolder;
  initialDraft?: WorkflowDraft;
  onDraftChange: (draft: WorkflowDraft) => void;
  onSaved: (config: Json, oldId: string, nextId?: string) => void;
  onReloadSaved: () => void;
  onBusyChange?: (busy: boolean) => void;
  onPersistenceWarning: (message: string) => void;
}) {
  const schemas = useMemo<Record<string, CatalogEntry>>(() => {
    const values: Record<string, CatalogEntry> = {};
    for (const entry of catalogEntries(catalog))
      if (entry.use && entry.kind) {
        const value = { ...entry, schema: entrySchema(entry, entry.kind) };
        values[`${entry.kind}:${entry.use}`] = value;
        if (!(entry.use in values) || entry.kind === "action")
          values[entry.use] = value;
      }
    for (const use of CANVAS_ACTION_USES)
      if (!values[`action:${use}`])
        values[`action:${use}`] = {
          use,
          kind: "action",
          schema: { type: "object", properties: {} },
          presentation: { name: labelFor(use) },
        };
    for (const [sourceId, source] of Object.entries(
      config.sources ?? {},
    ) as Array<[string, any]>) {
      const plugin = values[`source:${source.use}`] ?? values[source.use];
      values[`source:${sourceId}`] = {
        ...(plugin ?? {}),
        kind: "source",
        use: sourceId,
        configured: true,
        schema: entrySchema(plugin, "source") ?? {
          type: "object",
          properties: {},
        },
        presentation: { ...(plugin?.presentation ?? {}), name: sourceId },
      };
    }
    return values;
  }, [catalog, config.sources]);
  const graph = useMemo(
    () =>
      initialDraft
        ? { nodes: initialDraft.nodes, edges: initialDraft.edges }
        : workflowToGraph(workflow, schemas),
    [initialDraft, schemas, workflow],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>(
    graph.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const [base, setBase] = useState<WorkflowSummary>(
    initialDraft?.base ?? workflow,
  );
  const [viewport, setViewport] = useState<Viewport>(
    initialDraft?.viewport ?? { x: 0, y: 0, zoom: 1 },
  );
  const [selectedNode, setSelectedNode] = useState<GraphNode>();
  const [message, setMessage] = useState("");
  const [layoutError, setLayoutError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    onBusyChange?.(saving);
    return () => onBusyChange?.(false);
  }, [saving, onBusyChange]);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [metadataErrors, setMetadataErrors] = useState<Record<string, string>>(
    {},
  );
  const [loadedMtime, setLoadedMtime] = useState(0);
  const [promptFiles, setPromptFiles] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRaw, setSettingsRaw] = useState("");
  const [workflowTest, setWorkflowTest] = useState<WorkflowTestResult>();
  const [testingWorkflow, setTestingWorkflow] = useState(false);
  const [workflowResultVersion, setWorkflowResultVersion] = useState<number>();
  const [actionTest, setActionTest] = useState<ActionTestResult>();
  const [testingAction, setTestingAction] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [resultVersion, setResultVersion] = useState<number>();
  const [edgeEditing, setEdgeEditing] = useState<Edge>();
  const [edgeCondition, setEdgeCondition] = useState("succeeded");
  const [menuOpen, setMenuOpen] = useState<
    "duplicate" | "rename" | "delete" | undefined
  >();
  const [nextName, setNextName] = useState("");
  const history = useRef<{ nodes: GraphNode[]; edges: Edge[] }[]>([]);
  const future = useRef<{ nodes: GraphNode[]; edges: Edge[] }[]>([]);
  const dragSnapshot = useRef<
    { nodes: GraphNode[]; edges: Edge[] } | undefined
  >(undefined);
  const viewportReady = useRef(false);
  const dirty = useRef(Boolean(initialDraft?.dirty));
  const persisted = useRef({
    id: workflow.id,
    revision: base.revision,
    exists:
      Boolean(workflow.revision) ||
      Object.prototype.hasOwnProperty.call(config.workflows ?? {}, workflow.id),
  });
  const testToken = useRef(0);
  const snapshot = () => ({
    nodes: structuredClone(nodes),
    edges: structuredClone(edges),
  });
  const publish = useCallback(
    (
      nextNodes = nodes,
      nextEdges = edges,
      nextBase = base,
      nextViewport = viewport,
      nextDirty = true,
    ) => {
      testToken.current += 1;
      setTestingWorkflow(false);
      setTestingAction(false);
      dirty.current = nextDirty;
      onDraftChange({
        base: nextBase,
        nodes: nextNodes,
        edges: nextEdges,
        viewport: nextViewport,
        dirty: nextDirty,
      });
      setPreviewVersion((version) => version + 1);
    },
    [base, edges, nodes, onDraftChange, viewport],
  );
  useEffect(() => {
    let cancelled = false;
    void api
      .getConfigMtime(project)
      .then((mtime) => {
        if (!cancelled) setLoadedMtime(mtime);
      })
      .catch((error) => {
        if (!cancelled)
          setMetadataErrors((previous) => ({
            ...previous,
            revision: `Revision check unavailable: ${error instanceof Error ? error.message : String(error)}`,
          }));
      });
    void api
      .getPrompts(project)
      .then((library) => {
        if (!cancelled) setPromptFiles(library.prompts);
      })
      .catch((error) => {
        if (!cancelled)
          setMetadataErrors((previous) => ({
            ...previous,
            prompts: `Prompt library unavailable: ${error instanceof Error ? error.message : String(error)}`,
          }));
      });
    void api
      .getLayout(workflow.id, project)
      .then((layout) => {
        if (cancelled || initialDraft || dirty.current || !layout) return;
        const saved =
          layout.nodes && !Array.isArray(layout.nodes)
            ? Object.entries(layout.nodes).map(([id, position]) => ({
                id,
                ...(position as object),
              }))
            : layout.nodes;
        if (layout.viewport) setViewport(layout.viewport as Viewport);
        if (Array.isArray(saved))
          setNodes((current) =>
            current.map((node) => {
              const position = saved.find((entry: any) => entry.id === node.id);
              return position
                ? {
                    ...node,
                    position: {
                      x: position.x ?? node.position.x,
                      y: position.y ?? node.position.y,
                    },
                  }
                : node;
            }),
          );
      })
      .catch((error) => {
        if (!cancelled && !initialDraft)
          setMetadataErrors((previous) => ({
            ...previous,
            layout: `Saved layout unavailable: ${error instanceof Error ? error.message : String(error)}`,
          }));
      });
    return () => {
      cancelled = true;
      testToken.current += 1;
    }; // Refresh is explicit; polling must not replace the conflict baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, setNodes, workflow.id]);
  const commit = (nextNodes: GraphNode[], nextEdges: Edge[]) => {
    history.current.push(snapshot());
    future.current = [];
    setNodes(nextNodes);
    setEdges(nextEdges);
    publish(nextNodes, nextEdges);
  };
  const updateNode = (data: Partial<GraphNodeData>) => {
    if (!selectedNode) return;
    const next = nodes.map((node) =>
      node.id === selectedNode.id
        ? { ...node, data: { ...node.data, ...data } }
        : node,
    );
    setSelectedNode(next.find((node) => node.id === selectedNode.id));
    commit(next, edges);
  };
  const danglingMessage = () => {
    const edge = findDanglingEdges(nodes, edges)[0];
    if (edge)
      return `Dependency points to missing node '${!nodes.some((node) => node.id === edge.source) ? edge.source : edge.target}'.`;
    const reference = findDanglingActionReferences(nodes)[0];
    return reference
      ? `Action '${reference.nodeId}' references missing or incompatible action '${reference.actionId}'.`
      : undefined;
  };
  const save = async () => {
    if (saving) return;
    if (!/^[a-zA-Z0-9._:-]+$/.test(base.id))
      return setMessage(
        "Workflow name must use letters, numbers, '.', '_', ':' or '-'.",
      );
    const invalid = danglingMessage();
    if (invalid) return setMessage(invalid);
    setSaving(true);
    setMessage("");
    setLayoutError("");
    try {
      const mtime = await api.getConfigMtime(project);
      if (
        persisted.current.id === workflow.id &&
        loadedMtime &&
        mtime &&
        mtime !== loadedMtime
      )
        throw new Error(
          "Configuration changed on disk. Your draft is preserved. Duplicate it under a new ID, or use Reload saved to discard it and load the current revision.",
        );
      const nextWorkflow = graphToWorkflow({ nodes, edges }, base);
      const isNew = !persisted.current.exists;
      let targetId = base.id;
      let revision = persisted.current.revision;
      if (!isNew && base.id !== persisted.current.id) {
        const renamed = await api.renameWorkflow(
          persisted.current.id,
          base.id,
          project,
          revision,
        );
        targetId = base.id;
        revision = renamed.workflow?.revision;
        persisted.current = { id: targetId, revision, exists: true };
        if (revision === undefined)
          throw new Error(
            `Workflow was renamed to '${targetId}', but its revision was not returned. Reload saved before continuing.`,
          );
      }
      const result = isNew
        ? await api.createWorkflow(targetId, nextWorkflow as Json, project)
        : await api.saveWorkflow(
            targetId,
            nextWorkflow as Json,
            project,
            revision,
          );
      if (result?.workflow?.revision)
        nextWorkflow.revision = result.workflow.revision;
      persisted.current = {
        id: targetId,
        revision: nextWorkflow.revision,
        exists: true,
      };
      const next = {
        ...config,
        workflows: {
          ...(config.workflows ?? {}),
          ...(base.id !== workflow.id
            ? Object.fromEntries(
                Object.entries(config.workflows ?? {}).filter(
                  ([id]) => id !== workflow.id,
                ),
              )
            : {}),
          [targetId]: nextWorkflow,
        },
      };
      if (base.id !== workflow.id) delete next.workflows[workflow.id];
      try {
        await api.saveLayout(
          targetId,
          {
            nodes: nodes.map((node) => ({
              id: node.id,
              x: node.position.x,
              y: node.position.y,
            })),
            viewport,
          },
          project,
        );
      } catch (error) {
        const warning = `Workflow configuration saved, but canvas layout was not saved: ${error instanceof Error ? error.message : String(error)}`;
        setLayoutError(warning);
        onPersistenceWarning(warning);
      }
      dirty.current = false;
      onSaved(next, workflow.id, targetId);
      setLoadedMtime((await api.getConfigMtime(project)) || mtime);
      setMessage("Saved workflow configuration.");
    } catch (error) {
      const conflict =
        error instanceof api.ApiError && [409, 412].includes(error.status);
      setMessage(
        `${conflict ? "Revision conflict — " : "Save failed — "}${error instanceof Error ? error.message : String(error)} Your draft was kept.${persisted.current.id !== workflow.id ? ` The saved workflow is now named '${persisted.current.id}'; retrying Save targets that name.` : ""}`,
      );
    } finally {
      setSaving(false);
    }
  };
  const previewWorkflow = async () => {
    const invalid = danglingMessage();
    if (invalid) return setMessage(invalid);
    const token = ++testToken.current;
    const requestVersion = previewVersion;
    setTestingWorkflow(true);
    setTestingAction(false);
    setWorkflowTest(undefined);
    try {
      const result = await api.testWorkflowDraft(
        base.id,
        graphToWorkflow({ nodes, edges }, base) as Json,
        project,
      );
      if (token === testToken.current) {
        setWorkflowTest(result);
        setWorkflowResultVersion(requestVersion);
      }
    } catch (error) {
      if (token === testToken.current)
        setMessage(
          `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      if (token === testToken.current) setTestingWorkflow(false);
    }
  };
  const previewAction = async () => {
    if (!selectedNode || selectedNode.data.kind !== "action") return;
    const invalid = danglingMessage();
    if (invalid) return setMessage(invalid);
    const token = ++testToken.current;
    const requestVersion = previewVersion;
    setTestingAction(true);
    setTestingWorkflow(false);
    setActionTest(undefined);
    try {
      const result = await api.testAction(
        workflow.id,
        selectedNode.id,
        project,
        {
          workflow: graphToWorkflow({ nodes, edges }, base) as Json,
          action: {
            id: selectedNode.id,
            use: selectedNode.data.use,
            ...selectedNode.data.config,
          },
        },
      );
      if (token === testToken.current) {
        setActionTest(result);
        setResultVersion(requestVersion);
      }
    } catch (error) {
      if (token === testToken.current)
        setMessage(
          `Action preview failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      if (token === testToken.current) setTestingAction(false);
    }
  };
  const selectReference = (path: string, actionId?: string) => {
    if (!selectedNode) return;
    const ref = actionReferenceFor(selectedNode.data.use);
    const before = ref
      ? actionReferenceValue(selectedNode.data.config, path, ref.value)
      : undefined;
    const configValue = setActionReference(
      selectedNode.data.config,
      path,
      actionId,
      ref?.value,
    );
    const nextNodes = nodes.map((node) =>
      node.id === selectedNode.id
        ? { ...node, data: { ...node.data, config: configValue } }
        : node,
    );
    const nextEdges = syncActionReferenceEdge(
      edges,
      selectedNode.id,
      path,
      before,
      actionId,
    );
    setSelectedNode(nextNodes.find((node) => node.id === selectedNode.id));
    commit(nextNodes, nextEdges);
  };
  const changeUse = (use: string) => {
    if (!selectedNode) return;
    const ref = actionReferenceFor(selectedNode.data.use);
    const before = ref
      ? actionReferenceValue(selectedNode.data.config, ref.path, ref.value)
      : undefined;
    const nextEdges = ref
      ? syncActionReferenceEdge(
          edges,
          selectedNode.id,
          ref.path,
          before,
          undefined,
        )
      : edges;
    const nextNodes = nodes.map((node) =>
      node.id === selectedNode.id
        ? {
            ...node,
            data: {
              ...node.data,
              use,
              schema: entrySchema(
                schemas[`action:${use}`] ?? schemas[use],
                "action",
              ),
              config: { use, with: {} },
            },
          }
        : node,
    );
    setSelectedNode(nextNodes.find((node) => node.id === selectedNode.id));
    commit(nextNodes, nextEdges);
  };
  const deleteSelected = () => {
    if (!selectedNode || selectedNode.data.kind === "trigger") return;
    const id = selectedNode.id;
    const nextNodes = nodes
      .filter((node) => node.id !== id)
      .map((node) => {
        const ref = actionReferenceFor(node.data.use);
        return ref &&
          actionReferenceValue(node.data.config, ref.path, ref.value) === id
          ? {
              ...node,
              data: {
                ...node.data,
                config: setActionReference(
                  node.data.config,
                  ref.path,
                  undefined,
                  ref.value,
                ),
              },
            }
          : node;
      });
    setSelectedNode(undefined);
    commit(
      nextNodes,
      edges.filter((edge) => edge.source !== id && edge.target !== id),
    );
  };
  const applyNamedAction = async () => {
    if (saving) return;
    if (menuOpen === "delete") {
      setSaving(true);
      try {
        await api.deleteWorkflow(
          persisted.current.id,
          project,
          persisted.current.revision,
        );
        const next = { ...config, workflows: { ...(config.workflows ?? {}) } };
        delete next.workflows[workflow.id];
        onSaved(next, workflow.id);
        setMenuOpen(undefined);
      } catch (error) {
        setMessage(
          `delete failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setSaving(false);
      }
      return;
    }
    const id = nextName.trim();
    if (!/^[a-zA-Z0-9._:-]+$/.test(id))
      return setMessage("Use a valid workflow ID.");
    if (
      menuOpen === "duplicate" &&
      (Object.prototype.hasOwnProperty.call(config.workflows ?? {}, id) ||
        id === workflow.id)
    )
      return setMessage("A workflow with this ID already exists.");
    setSaving(true);
    try {
      if (menuOpen === "duplicate") {
        const value = graphToWorkflow({ nodes, edges }, { ...base, id });
        await api.createWorkflow(id, value as Json, project);
        onSaved(
          {
            ...config,
            workflows: { ...(config.workflows ?? {}), [id]: value },
          },
          workflow.id,
          id,
        );
      } else if (menuOpen === "rename") {
        setBase({ ...base, id });
        publish(nodes, edges, { ...base, id });
      }
      setMenuOpen(undefined);
    } catch (error) {
      setMessage(
        `${menuOpen} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSaving(false);
    }
  };
  const addAction = (use: string) => {
    const id = `${use.split(/[/:]/).pop() || "action"}-${nodes.filter((node) => node.data.kind === "action").length + 1}`;
    const node: GraphNode = {
      id,
      type: "action",
      position: { x: 400, y: 140 + nodes.length * 30 },
      data: {
        label: id,
        use,
        kind: "action",
        config: { use, with: {} },
        schema: (schemas[`action:${use}`] ?? schemas[use])?.schema,
      },
    };
    setSelectedNode(node);
    setPaletteOpen(false);
    commit([...nodes, node], edges);
  };
  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    future.current.push(snapshot());
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setSelectedNode(undefined);
    publish(previous.nodes, previous.edges);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    history.current.push(snapshot());
    setNodes(next.nodes);
    setEdges(next.edges);
    publish(next.nodes, next.edges);
  };
  return (
    <section className="editor" aria-busy={saving} inert={saving}>
      <Stack gap="xs" className="editor-toolbar">
        <Group justify="space-between" align="end">
          <Group align="end">
            <TextInput
              label="Workflow name"
              value={base.id}
              onChange={(event) => {
                const next = { ...base, id: event.currentTarget.value };
                setBase(next);
                publish(nodes, edges, next);
              }}
            />
            <Switch
              label="Enabled"
              checked={base.enabled !== false}
              onChange={(event) => {
                const next = { ...base, enabled: event.currentTarget.checked };
                setBase(next);
                publish(nodes, edges, next);
              }}
            />
            <Badge color={dirty.current ? "yellow" : "green"}>
              {dirty.current ? "Unsaved draft" : "Saved"}
            </Badge>
          </Group>
          <Group gap="xs">
            <Button loading={saving} onClick={save} leftSection={<Save size={16} aria-hidden />}>
              Save
            </Button>
            <Menu shadow="md">
              <Menu.Target>
                <ActionIcon variant="default" aria-label="Workflow actions">
                  <Ellipsis size={19} aria-hidden />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => setReloadOpen(true)}>
                  Reload saved
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    setSettingsRaw(
                      JSON.stringify(
                        {
                          ...Object.fromEntries(
                            Object.entries(base).filter(
                              ([key]) =>
                                !["id", "source", "on", "jobs"].includes(key),
                            ),
                          ),
                          fire: base.on?.fire,
                        },
                        null,
                        2,
                      ),
                    );
                    setSettingsOpen(true);
                  }}
                >
                  Advanced settings
                </Menu.Item>
                <Menu.Divider />
                <Menu.Label>Canvas</Menu.Label>
                <Menu.Item
                  disabled={!history.current.length}
                  onClick={undo}
                >
                  Undo
                </Menu.Item>
                <Menu.Item disabled={!future.current.length} onClick={redo}>
                  Redo
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    const next = autoLayout(nodes, edges);
                    setNodes(next);
                    publish(next, edges);
                  }}
                >
                  Auto-layout
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  onClick={() => {
                    setNextName(`${base.id}-copy`);
                    setMenuOpen("duplicate");
                  }}
                >
                  Duplicate
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    setNextName(base.id);
                    setMenuOpen("rename");
                  }}
                >
                  Rename
                </Menu.Item>
                <Menu.Item color="red" onClick={() => setMenuOpen("delete")}>
                  Delete
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </Stack>
      {Object.entries(metadataErrors).map(([key, text]) => (
        <Alert key={key} color="yellow">
          {text}
        </Alert>
      ))}
      {message && (
        <Alert
          color={
            message.includes("failed") || message.includes("conflict")
              ? "red"
              : "blue"
          }
          withCloseButton
          onClose={() => setMessage("")}
        >
          {message}
        </Alert>
      )}
      {layoutError && <Alert color="yellow">{layoutError}</Alert>}
      {workflowTest && (
        <WorkflowPreview
          result={workflowTest}
          stale={
            workflowResultVersion !== undefined &&
            workflowResultVersion !== previewVersion
          }
        />
      )}
      <div className="canvas-wrap">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              const next = applyNodeChanges(changes, nodes) as GraphNode[];
              setNodes(next);
              if (
                changes.some((change) =>
                  ["position", "remove", "add", "replace"].includes(
                    change.type,
                  ),
                )
              )
                publish(next, edges);
            }}
            onNodesDelete={(deleted) => {
              const ids = new Set(deleted.map((node) => node.id));
              commit(
                nodes.filter((node) => !ids.has(node.id)),
                edges.filter(
                  (edge) => !ids.has(edge.source) && !ids.has(edge.target),
                ),
              );
            }}
            onNodeDragStart={() => {
              dragSnapshot.current = snapshot();
            }}
            onNodeDragStop={() => {
              if (dragSnapshot.current) {
                history.current.push(dragSnapshot.current);
                future.current = [];
                dragSnapshot.current = undefined;
              }
            }}
            onEdgesChange={(changes) => {
              const next = applyEdgeChanges(changes, edges);
              setEdges(next);
              if (
                changes.some((change) =>
                  ["remove", "add", "replace", "reset"].includes(change.type),
                )
              )
                publish(nodes, next);
            }}
            onConnect={(connection: Connection) => {
              if (
                !connection.source ||
                !connection.target ||
                wouldCycle(edges, connection.source, connection.target)
              )
                return setMessage("That connection would create a cycle.");
              commit(
                nodes,
                addEdge(
                  { ...connection, type: "smoothstep", label: "then" },
                  edges,
                ),
              );
            }}
            onReconnect={(oldEdge, connection) => {
              if (
                !connection.source ||
                !connection.target ||
                wouldCycle(
                  edges.filter((edge) => edge.id !== oldEdge.id),
                  connection.source,
                  connection.target,
                )
              )
                return setMessage("That connection would create a cycle.");
              commit(nodes, reconnectEdge(oldEdge, connection, edges));
            }}
            onEdgeDoubleClick={(_, edge) => {
              setEdgeEditing(edge);
              setEdgeCondition(String(edge.label || "succeeded"));
            }}
            onMoveEnd={(event, next) => {
              setViewport(next);
              if (event && viewportReady.current) publish(nodes, edges, base, next);
              else viewportReady.current = true;
            }}
            onNodeClick={(_, node) => {
              testToken.current += 1;
              setTestingWorkflow(false);
              setTestingAction(false);
              setSelectedNode(node);
              setActionTest(undefined);
              setPaletteOpen(false);
            }}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#c4c4c8" gap={24} size={1} />
            <Controls orientation="horizontal" />
          </ReactFlow>
        </ReactFlowProvider>
        <Button
          className="add-node-button"
          variant="default"
          leftSection={<Plus size={18} aria-hidden />}
          onClick={() => setPaletteOpen((open) => !open)}
        >
          Add node
        </Button>
        {paletteOpen && <NodePalette schemas={schemas} onAdd={addAction} />}
        <Button className="canvas-preview" leftSection={<FlaskConical size={18} aria-hidden />} loading={testingWorkflow} onClick={previewWorkflow}>Preview workflow</Button>
      </div>
      {selectedNode && (
        <PropertyPanel
          key={selectedNode.id}
          node={selectedNode}
          nodes={nodes}
          edges={edges}
          schemas={schemas}
          prompts={promptFiles}
          project={project}
          onChange={updateNode}
          onReference={selectReference}
          onUseChange={changeUse}
          onDelete={deleteSelected}
          onClose={() => setSelectedNode(undefined)}
          onRaw={() => {
            setRaw(JSON.stringify(selectedNode.data.config ?? {}, null, 2));
            setRawOpen(true);
          }}
          onPreview={previewAction}
          testing={testingAction}
          result={actionTest}
          stale={
            resultVersion !== undefined && resultVersion !== previewVersion
          }
        />
      )}
      {rawOpen && (
        <Modal opened onClose={() => setRawOpen(false)} title="Advanced JSON">
          <Stack>
            <Textarea
              value={raw}
              onChange={(event) => setRaw(event.currentTarget.value)}
              autosize
              minRows={12}
              error={
                raw.trim()
                  ? (() => {
                      try {
                        JSON.parse(raw);
                        return undefined;
                      } catch {
                        return "Invalid JSON — text is preserved until it is valid.";
                      }
                    })()
                  : undefined
              }
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setRawOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  try {
                    updateNode({ config: JSON.parse(raw) });
                    setRawOpen(false);
                  } catch {
                    setMessage(
                      "Invalid JSON configuration. The editor text is still open and unchanged.",
                    );
                  }
                }}
              >
                Apply JSON
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
      <Modal
        opened={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Advanced workflow settings"
      >
        <Stack>
          <Text size="sm" c="dimmed">
            Scheduling, concurrency, retry, timeout, and unsupported fields are
            preserved here. Trigger and jobs remain managed by the canvas.
          </Text>
          <Textarea
            value={settingsRaw}
            onChange={(event) => setSettingsRaw(event.currentTarget.value)}
            autosize
            minRows={12}
            error={
              settingsRaw.trim()
                ? (() => {
                    try {
                      JSON.parse(settingsRaw);
                      return undefined;
                    } catch {
                      return "Invalid JSON — text is preserved until it is valid.";
                    }
                  })()
                : undefined
            }
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSettingsOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                try {
                  const { fire, ...settings } = JSON.parse(settingsRaw);
                  const next = { ...base, ...settings };
                  delete (next as Json).jobs;
                  delete (next as Json).on;
                  delete (next as Json).source;
                  const preserved = {
                    ...next,
                    id: base.id,
                    source: base.source,
                    on: {
                      ...(base.on ?? {}),
                      ...(fire === undefined ? {} : { fire }),
                    },
                    jobs: base.jobs,
                  };
                  setBase(preserved);
                  publish(nodes, edges, preserved);
                  setSettingsOpen(false);
                } catch {
                  setMessage(
                    "Invalid workflow settings JSON. The editor text is still open and unchanged.",
                  );
                }
              }}
            >
              Apply settings
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={Boolean(menuOpen)}
        onClose={() => !saving && setMenuOpen(undefined)}
        closeOnEscape={!saving}
        closeOnClickOutside={!saving}
        title={
          menuOpen === "delete"
            ? "Delete workflow"
            : menuOpen === "duplicate"
              ? "Duplicate workflow"
              : "Rename workflow"
        }
        centered
      >
        <Stack>
          {menuOpen === "delete" ? (
            <Text>
              Delete “{workflow.id}”? This removes its saved configuration, not
              repository files.
            </Text>
          ) : (
            <TextInput
              label="Workflow ID"
              value={nextName}
              onChange={(event) => setNextName(event.currentTarget.value)}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setMenuOpen(undefined)}>
              Cancel
            </Button>
            <Button
              color={menuOpen === "delete" ? "red" : undefined}
              loading={saving}
              onClick={() => void applyNamedAction()}
            >
              {menuOpen === "delete"
                ? "Delete"
                : menuOpen === "rename"
                  ? "Use new name"
                  : "Duplicate"}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={reloadOpen}
        onClose={() => setReloadOpen(false)}
        title="Reload saved workflow"
      >
        <Stack>
          <Text size="sm">
            Discard this workflow's unsaved changes and reload its saved
            revision? Other workflow drafts stay available.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setReloadOpen(false)}>
              Keep editing
            </Button>
            <Button color="red" onClick={onReloadSaved}>
              Discard and reload
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={Boolean(edgeEditing)}
        onClose={() => setEdgeEditing(undefined)}
        title="Dependency condition"
      >
        <Stack>
          <Select
            label="Run when upstream is"
            data={["succeeded", "failed", "started", "skipped"]}
            value={edgeCondition}
            onChange={(value) => setEdgeCondition(value ?? "succeeded")}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEdgeEditing(undefined)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (edgeEditing)
                  commit(
                    nodes,
                    edges.map((entry) =>
                      entry.id === edgeEditing.id
                        ? { ...entry, label: edgeCondition }
                        : entry,
                    ),
                  );
                setEdgeEditing(undefined);
              }}
            >
              Apply
            </Button>
          </Group>
        </Stack>
      </Modal>
    </section>
  );
}

function NodePalette({
  schemas,
  onAdd,
}: {
  schemas: Record<string, CatalogEntry>;
  onAdd: (use: string) => void;
}) {
  const entries = CANVAS_ACTION_USES.map(
    (use) => schemas[`action:${use}`] ?? schemas[use],
  ).filter((entry): entry is CatalogEntry => Boolean(entry?.use));
  return (
    <div className="node-palette">
      <Text size="xs" fw={700}>
        NODE CATALOG
      </Text>
      {entries.map((entry) => (
        <Button
          key={entry.use}
          variant="subtle"
          justify="flex-start"
          onClick={() => onAdd(entry.use!)}
        >
          {entryLabel(entry)}
        </Button>
      ))}
    </div>
  );
}

function PropertyPanel({
  node,
  nodes,
  edges,
  schemas,
  prompts,
  project,
  onChange,
  onReference,
  onUseChange,
  onDelete,
  onClose,
  onRaw,
  onPreview,
  testing,
  result,
  stale,
}: {
  node: GraphNode;
  nodes: GraphNode[];
  edges: Edge[];
  schemas: Record<string, CatalogEntry>;
  prompts: string[];
  project?: ProjectFolder;
  onChange: (data: Partial<GraphNodeData>) => void;
  onReference: (path: string, actionId?: string) => void;
  onUseChange: (use: string) => void;
  onDelete: () => void;
  onClose: () => void;
  onRaw: () => void;
  onPreview: () => void;
  testing: boolean;
  result?: ActionTestResult;
  stale: boolean;
}) {
  const kind = node.data.kind === "trigger" ? "source" : "action";
  const schema =
    node.data.schema ??
    entrySchema(
      schemas[`${kind}:${node.data.use}`] ?? schemas[node.data.use],
      kind,
    );
  const properties = schema?.properties ?? {};
  const config = node.data.config ?? {};
  const field = (name: string) =>
    node.data.kind === "trigger" ? config[name] : (config.with ?? config)[name];
  const setField = (name: string, value: any) => {
    const current = node.data.kind === "trigger" ? config : (config.with ?? {});
    const next =
      name === "prompt" || name === "promptFile"
        ? setPromptInput(
            current,
            name,
            typeof value === "string" ? value : undefined,
          )
        : { ...current, [name]: value };
    onChange({
      config: node.data.kind === "trigger" ? next : { ...config, with: next },
    });
  };
  const ref =
    node.data.kind === "action" ? actionReferenceFor(node.data.use) : undefined;
  const selected = ref
    ? actionReferenceValue(config, ref.path, ref.value)
    : undefined;
  const candidates = ref
    ? upstreamReferenceNodes(nodes, edges, node.id, [
        ref.upstreamUse,
        ...(ref.alternateUpstreamUses ?? []),
      ])
    : [];
  const entries = Object.values(schemas).filter(
    (entry, index, all) =>
      entry.kind === kind &&
      entry.use &&
      (kind !== "source" || entry.configured) &&
      (kind !== "action" ||
        canvasActionUses.has(entry.use) ||
        entry.use === node.data.use) &&
      all.findIndex(
        (candidate) =>
          candidate.kind === entry.kind && candidate.use === entry.use,
      ) === index,
  );
  const linear =
    node.data.kind === "trigger" &&
    ["label", "labels", "statuses", "statusTypes", "assignee"].some(
      (name) => name in properties || name in config,
    );
  return (
    <aside className="property-panel">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={700}>
            {node.data.kind === "trigger"
              ? "Trigger settings"
              : "Action settings"}
          </Text>
          <ActionIcon
            variant="subtle"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </ActionIcon>
        </Group>
        <Select
          searchable
          label={node.data.kind === "trigger" ? "Source" : "Action"}
          data={entries.map((entry) => ({
            value: entry.use!,
            label: entryLabel(entry),
          }))}
          value={node.data.use}
          onChange={(use) =>
            use &&
            (node.data.kind === "action"
              ? onUseChange(use)
              : onChange({
                  use,
                  schema: entrySchema(
                    schemas[`${kind}:${use}`] ?? schemas[use],
                    kind,
                  ),
                  config: {},
                }))
          }
        />
        {ref && (
          <Select
            searchable
            label={ref.label}
            description="This creates the matching ordering dependency."
            data={[
              { value: "", label: "No referenced action" },
              ...candidates.map((candidate) => ({
                value: candidate.id,
                label: `${candidate.data.label} · ${candidate.data.use}`,
              })),
            ]}
            value={selected ?? ""}
            onChange={(value) => onReference(ref.path, value || undefined)}
          />
        )}
        {node.data.kind === "action" && (
          <>
            <TextInput
              label="Run condition (if)"
              value={config.if ?? ""}
              onChange={(event) =>
                onChange({
                  config: {
                    ...config,
                    if: event.currentTarget.value || undefined,
                  },
                })
              }
            />
            <Checkbox
              label="Action enabled"
              checked={config.enabled !== false}
              onChange={(event) =>
                onChange({
                  config: { ...config, enabled: event.currentTarget.checked },
                })
              }
            />
          </>
        )}
        <Divider />
        {linear ? (
          <LinearFilters
            sourceId={node.data.use}
            project={project}
            value={config}
            onChange={setField}
          />
        ) : (
          Object.entries(properties)
            .filter(
              ([name]) =>
                name !== ref?.path && name !== ref?.path.split(".")[0],
            )
            .map(([name, definition]: [string, any]) =>
              name === "promptFile" ? (
                <Select
                  key={name}
                  searchable
                  clearable
                  label="Saved prompt"
                  data={prompts.map((file) => ({
                    value: file,
                    label: file.replace(/^\.task-relay\/prompts\//, ""),
                  }))}
                  value={field(name) ?? null}
                  onChange={(value) => setField(name, value || undefined)}
                />
              ) : (
                <SchemaField
                  key={name}
                  name={name}
                  definition={definition}
                  value={field(name)}
                  onChange={(value) => setField(name, value)}
                />
              ),
            )
        )}
        {node.data.kind === "action" && (
          <Button onClick={onPreview} loading={testing}>
            Preview current draft action
          </Button>
        )}
        {result && <ActionPreview result={result} stale={stale} />}
        <Button variant="default" onClick={onRaw}>
          Advanced JSON
        </Button>
        {node.data.kind === "action" && (
          <Button color="red" variant="light" onClick={onDelete}>
            Delete node
          </Button>
        )}
      </Stack>
    </aside>
  );
}
function LinearFilters({
  sourceId,
  project,
  value,
  onChange,
}: {
  sourceId: string;
  project?: ProjectFolder;
  value: Json;
  onChange: (name: string, value: any) => void;
}) {
  const [options, setOptions] = useState<api.LinearTriggerOptions>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const requestSequence = useRef(0);
  const reload = useCallback(async () => {
    if (!project) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await api.getLinearTriggerOptions(sourceId, project);
      if (sequence === requestSequence.current) setOptions(next);
    } catch (reason) {
      if (sequence === requestSequence.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [project?.id, sourceId]);
  useEffect(() => {
    void reload();
    return () => {
      requestSequence.current++;
    };
  }, [reload]);
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="sm" fw={600}>
          Linear filters
        </Text>
        <Button
          size="compact-xs"
          variant="subtle"
          loading={loading}
          onClick={() => void reload()}
        >
          Refresh
        </Button>
      </Group>
      {error && (
        <Text size="xs" c="red">
          Could not load choices: {error}. Existing values are preserved.
        </Text>
      )}
      <Select
        searchable
        clearable
        label="Label"
        placeholder="Any label"
        data={options?.labels ?? []}
        value={value.label ?? null}
        onChange={(next) => onChange("label", next || undefined)}
        disabled={loading}
        nothingFoundMessage="No labels found"
      />
      <MultiSelect
        searchable
        clearable
        label="Workflow status"
        placeholder="Any status"
        data={[
          ...new Set([
            ...(options?.statuses.map((status) => status.name) ?? []),
            ...(value.statuses ?? []),
          ]),
        ]}
        value={value.statuses ?? []}
        onChange={(next) => onChange("statuses", next)}
        disabled={loading}
        nothingFoundMessage="No statuses found"
      />
      <MultiSelect
        label="Status type"
        placeholder="Any status type"
        searchable
        clearable
        disabled={loading}
        data={[
          ...new Set([
            ...(options?.statuses
              .map((status) => status.type)
              .filter((type): type is string => Boolean(type)) ?? []),
            ...(value.statusTypes ?? []),
          ]),
        ]}
        value={value.statusTypes ?? []}
        onChange={(next) => onChange("statusTypes", next)}
      />
      <Select
        searchable
        clearable
        label="Assignee"
        placeholder="Anyone"
        data={
          options?.users.map((user) => ({
            value: user.id,
            label: user.name,
          })) ?? []
        }
        value={value.assignee ?? null}
        onChange={(next) => onChange("assignee", next || undefined)}
        disabled={loading}
        nothingFoundMessage="No assignees found"
      />
    </Stack>
  );
}
function SchemaField({
  name,
  definition,
  value,
  onChange,
}: {
  name: string;
  definition: any;
  value: any;
  onChange: (value: any) => void;
}) {
  const label = definition.title || name.replace(/[-_]/g, " ");
  if (name === "prompt") return <Textarea label={label} description={definition.description} value={value ?? ""} onChange={event => onChange(event.currentTarget.value)} autosize minRows={3} />;
  if (definition.enum)
    return (
      <Select
        searchable
        label={label}
        data={definition.enum.map(String)}
        value={value ?? null}
        onChange={onChange}
      />
    );
  if (definition.type === "boolean")
    return (
      <Checkbox
        label={label}
        checked={Boolean(value ?? definition.default)}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    );
  if (definition.type === "object" || definition.type === "array")
    return <TextAreaJson label={label} value={value} onChange={onChange} />;
  return (
    <TextInput
      label={label}
      description={definition.description}
      type={
        definition.type === "number" || definition.type === "integer"
          ? "number"
          : undefined
      }
      value={value ?? ""}
      onChange={(event) =>
        onChange(
          definition.type === "number" || definition.type === "integer"
            ? event.currentTarget.value === ""
              ? undefined
              : Number(event.currentTarget.value)
            : event.currentTarget.value,
        )
      }
    />
  );
}
function TextAreaJson({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  const [error, setError] = useState("");
  return (
    <Textarea
      label={label}
      value={text}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        try {
          onChange(next.trim() ? JSON.parse(next) : undefined);
          setError("");
        } catch {
          setError("Invalid JSON is kept while you edit.");
        }
      }}
      error={error || undefined}
      autosize
      minRows={3}
    />
  );
}
function ActionPreview({
  result,
  stale,
}: {
  result: ActionTestResult;
  stale: boolean;
}) {
  const eligible = result.eligibleCount;
  return (
    <Alert
      color={stale ? "yellow" : "blue"}
      title={stale ? "Preview may be stale" : "Current draft preview"}
    >
      <Text size="sm">
        {eligible} of {result.triggerMatchCount} matching ticket
        {result.triggerMatchCount === 1 ? "" : "s"} can run now.
      </Text>
      {result.matches.length ? (
        result.matches.map((match, index) => (
          <Text size="xs" key={`${match.id}-${index}`}>
            {match.id || "Ticket"}:{" "}
            {match.eligible === false
              ? `blocked — ${match.reason || match.decision || "not eligible"}`
              : "eligible"}
          </Text>
        ))
      ) : (
        <Text size="xs">No tickets matched the trigger.</Text>
      )}
      {result.reasons.map((reason, index) => (
        <Text size="xs" key={`${reason}-${index}`}>
          {reason}
        </Text>
      ))}
    </Alert>
  );
}
function WorkflowPreview({
  result,
  stale,
}: {
  result: WorkflowTestResult;
  stale: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const title = stale ? "Draft changed after this preview" : "Preview results";
  const blocked = result.triggerMatchCount - result.eligibleCount;
  return (
    <>
      <Alert color={stale ? "yellow" : "blue"} title={title}>
        <Group justify="space-between" align="center" wrap="nowrap">
          <div>
            <Text size="sm">
              {result.eligibleCount} eligible of {result.triggerMatchCount}{" "}
              matching item{result.triggerMatchCount === 1 ? "" : "s"}.
            </Text>
            {blocked > 0 && (
              <Text size="xs" c="dimmed">
                {blocked} blocked; inspect details before changing the draft.
              </Text>
            )}
          </div>
          <Button size="xs" variant="light" onClick={() => setOpened(true)}>
            View details
          </Button>
        </Group>
      </Alert>
      <Drawer
        opened={opened}
        onClose={() => setOpened(false)}
        position="right"
        size="md"
        title={title}
        zIndex={250}
      >
        <Stack gap="md">
          <Text size="sm">
            {result.eligibleCount} of {result.triggerMatchCount} matching items
            are eligible. This preview does not start work.
          </Text>
          {!result.items.length && (
            <Text size="sm" c="dimmed">
              No items matched the trigger conditions.
            </Text>
          )}
          {result.items.map((item, index) => (
            <Paper
              key={`${item.id ?? item.identifier ?? "item"}-${index}`}
              withBorder
              p="sm"
            >
              <Stack gap={4}>
                <Group justify="space-between" wrap="nowrap">
                  <Text size="sm" fw={600}>
                    {item.identifier ?? item.id ?? "Item"}
                  </Text>
                  <Badge color={item.eligible ? "teal" : "orange"}>
                    {item.eligible ? "eligible" : "blocked"}
                  </Badge>
                </Group>
                {!item.eligible && (
                  <Text size="xs" c="dimmed">
                    {item.reason || item.decision || "Not eligible"}
                  </Text>
                )}
                {item.jobs?.map((job, jobIndex) => (
                  <Text size="xs" c="dimmed" key={`${job.id ?? jobIndex}`}>
                    {job.id ?? "Job"}:{" "}
                    {job.eligible
                      ? "eligible"
                      : job.reason || job.decision || "blocked"}
                  </Text>
                ))}
              </Stack>
            </Paper>
          ))}
        </Stack>
      </Drawer>
    </>
  );
}

export default Workflows;
