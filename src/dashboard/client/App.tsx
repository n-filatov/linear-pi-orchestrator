import { useCallback, useEffect, useRef, useState } from "react";
import { House, Workflow, Terminal, FolderGit2, RefreshCw, type LucideIcon } from "lucide-react";
import {
  Alert,
  AppShell,
  Badge,
  Burger,
  Button,
  Group,
  MantineProvider,
  Modal,
  NavLink,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@mantine/core/styles.css";
import "./styles.css";
import "./canvas-overrides.css";
import "./dashboard.css";
import "./n8n-layout.css";
import * as api from "./api";
import type { ProjectFolder } from "./api";
import {
  dashboardRoutePath,
  parseDashboardRoute,
  routeForPage,
  type DashboardPage,
  type DashboardRoute,
} from "./router";
import { useResource } from "./resource";
import { dashboardTheme } from "./theme";
import {
  formatTime,
  repositoryName,
  ResourceFeedback,
} from "./components/shared";
import { Overview } from "./pages/Overview";
import { Repositories, RegisterDialog } from "./pages/Repositories";
import Workflows from "./pages/Workflows";
import { Executions } from "./pages/Executions";
import { Workers } from "./pages/Workers";

const navigation: { page: DashboardPage; label: string; icon: LucideIcon }[] = [
  { page: "home", label: "Overview", icon: House },
  { page: "workflows", label: "Workflows", icon: Workflow },
  { page: "workers", label: "Workers", icon: Terminal },
  { page: "repositories", label: "Repositories", icon: FolderGit2 },
];

const selectedRepositoryStorageKey = "task-relay:selected-repository";

function readSelectedRepository(): string | undefined {
  try {
    return window.localStorage.getItem(selectedRepositoryStorageKey) || undefined;
  } catch {
    return undefined;
  }
}

function persistSelectedRepository(projectId?: string) {
  try {
    if (projectId) window.localStorage.setItem(selectedRepositoryStorageKey, projectId);
    else window.localStorage.removeItem(selectedRepositoryStorageKey);
  } catch {
    // Storage is a preference only; private-mode restrictions must not block work.
  }
}

function Dashboard() {
  const [route, setRoute] = useState(() =>
    parseDashboardRoute(window.location.pathname, window.location.search),
  );
  const [mobileOpened, setMobileOpened] = useState(false);
  const [registerOpened, setRegisterOpened] = useState(false);
  const [selectedRepository, setSelectedRepository] = useState(
    readSelectedRepository,
  );
  const dirty = useRef(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<DashboardRoute>();
  // Legacy detail-only pages remain addressable in old browser history, but
  // deliberately do not compete with the three daily work surfaces.
  const page =
    route.page === "plugins" ||
    route.page === "settings" ||
    (route.page === "executions" && route.executionId)
      ? "home"
      : route.page;
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const folders = useResource("projects", api.getProjects, 10000);
  const watchers = useResource("watchers", api.getWatcherStatuses, 5000);
  // A successful supervisor snapshot lists active/known controllers. Absence
  // means this supervisor is stopped; a failed initial request remains unknown.
  const projects = (folders.data ?? []).map((project) => ({
    ...project,
    watcher: watchers.data
      ? (watchers.data.find((status) => status.projectId === project.id) ?? {
          projectId: project.id,
          state: "stopped" as const,
        })
      : undefined,
  }));
  const project = projects.find((project) => project.id === route.projectId);
  const requestedProject: ProjectFolder | undefined =
    route.projectId && page !== "repositories"
      ? (project ?? { id: route.projectId, root: "" })
      : undefined;
  const scopeKey = requestedProject?.id || "all";
  const workers = useResource(
    `workers:${page === "workers" ? scopeKey : "inactive"}`,
    () => page === "workers" ? api.getWorkers(requestedProject) : Promise.resolve([]),
    5000,
  );
  const workflows = useResource(
    `workflows:${page === "workflows" ? scopeKey : "inactive"}`,
    () =>
      page === "workflows"
        ? api.getWorkflows(requestedProject)
        : Promise.resolve([]),
    10000,
  );
  const executions = useResource(
    `executions:${scopeKey}`,
    () => api.getExecutions(requestedProject),
    5000,
  );
  const catalog = useResource(`catalog:${page === "workflows" ? scopeKey : "inactive"}`, () =>
    page === "workflows" && requestedProject
      ? api.getCatalog(requestedProject)
      : Promise.resolve({}),
  );
  const config = useResource(
    `config:${page === "workflows" ? scopeKey : "inactive"}`,
    () =>
      page === "workflows" && requestedProject
        ? api.getConfig(requestedProject)
        : Promise.resolve({ config: {} }),
    10000,
  );
  const commitRoute = useCallback((next: DashboardRoute, replace = false) => {
    const path = dashboardRoutePath(next);
    if (`${window.location.pathname}${window.location.search}` !== path)
      window.history[replace ? "replaceState" : "pushState"]({}, "", path);
    setRoute(next);
    setMobileOpened(false);
  }, []);
  const navigate = useCallback(
    (next: DashboardRoute, replace = false) => {
      if (
        operationBusy &&
        (next.page !== "workflows" || next.projectId !== route.projectId)
      )
        return;
      if (
        dirty.current &&
        (next.page !== "workflows" || next.projectId !== route.projectId)
      ) {
        setPendingRoute(next);
        return;
      }
      commitRoute(next, replace);
    },
    [commitRoute, route, operationBusy],
  );
  const navigatePage = (page: DashboardPage) =>
    navigate(
      routeForPage(
        page,
        page === "repositories"
          ? undefined
          : route.projectId || selectedRepository,
      ),
    );
  const selectRepository = (value: string | null) => {
    const projectId = value && value !== "all" ? value : undefined;
    setSelectedRepository(projectId);
    persistSelectedRepository(projectId);
    navigate(
      routeForPage(page === "repositories" ? "home" : page, projectId),
    );
  };
  useEffect(() => {
    if (!folders.data) return;
    if (route.projectId) {
      if (folders.data.some((folder) => folder.id === route.projectId)) {
        if (selectedRepository !== route.projectId) {
          setSelectedRepository(route.projectId);
          persistSelectedRepository(route.projectId);
        }
      }
      return;
    }
    if (!selectedRepository || page === "repositories") return;
    if (folders.data.some((folder) => folder.id === selectedRepository)) {
      navigate(routeForPage(page, selectedRepository), true);
    } else {
      setSelectedRepository(undefined);
      persistSelectedRepository(undefined);
    }
  }, [
    folders.data,
    navigate,
    page,
    route.projectId,
    selectedRepository,
  ]);
  useEffect(() => {
    const pop = () => {
      const next = parseDashboardRoute(
        window.location.pathname,
        window.location.search,
      );
      if (operationBusy) {
        window.history.pushState({}, "", dashboardRoutePath(route));
        return;
      }
      if (
        dirty.current &&
        (next.page !== "workflows" || next.projectId !== route.projectId)
      ) {
        window.history.pushState({}, "", dashboardRoutePath(route));
        setPendingRoute(next);
      } else setRoute(next);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("beforeunload", unload);
    };
  }, [route, operationBusy]);
  const refresh = async () => {
    await Promise.allSettled([
      folders.refresh(),
      watchers.refresh(),
      workflows.refresh(),
      executions.refresh(),
      workers.refresh(),
      catalog.refresh(),
      config.refresh(),
    ]);
  };
  const resources = [
    folders,
    watchers,
    workflows,
    executions,
    ...(page === "workers" ? [workers] : []),
    ...(route.projectId ? [catalog, config] : []),
  ];
  const errors = resources.filter((resource) => resource.error);
  const successful = resources
    .map((resource) => resource.refreshedAt)
    .filter((value): value is number => Boolean(value));
  const lastRefresh = successful.length ? Math.max(...successful) : undefined;
  const scopeName =
    page === "repositories"
      ? "All repositories"
      : project
        ? repositoryName(project)
        : route.projectId
          ? route.projectId
          : "All repositories";
  const required =
    page === "repositories"
      ? ([
          ["Repositories", folders],
          ["Watcher status", watchers],
          ["Executions", executions],
        ] as const)
      : page === "workflows"
        ? ([
            ["Workflows", workflows],
            ["Configuration", config],
            ["Plugin catalog", catalog],
          ] as const)
        : page === "workers"
          ? ([["Workers", workers]] as const)
        : page === "executions"
          ? ([["Executions", executions]] as const)
          : ([["Executions", executions]] as const);
  return (
    <AppShell
      className={page === "workflows" && route.workflowId ? "relay-shell canvas-page" : "relay-shell"}
      layout="alt"
      header={{ height: 68 }}
      navbar={{
        width: 224,
        breakpoint: "sm",
        collapsed: { mobile: !mobileOpened },
      }}
      padding={{ base: "md", md: "xl" }}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm">
            <Burger
              opened={mobileOpened}
              onClick={() => setMobileOpened((value) => !value)}
              hiddenFrom="sm"
              size="sm"
              aria-label="Toggle navigation"
            />
            <div>
              <Text size="xs" c="dimmed">
                {scopeName}
              </Text>
              <Title order={3}>
                {route.workflowId || navigation.find((item) => item.page === page)?.label}
              </Title>
            </div>
          </Group>
          <Group gap="xs">
            <Button
              variant="default"
              onClick={() => void refresh()}
              loading={resources.some((resource) => resource.refreshing)}
              aria-label="Refresh dashboard"
              leftSection={<RefreshCw size={16} aria-hidden />}
            >
              Refresh
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md">
        <Stack h="100%" gap="lg">
          <Group gap="sm">
            <span className="brand-mark"><Workflow size={23} aria-hidden /></span>
            <div>
              <Text fw={650}>task relay</Text>
              <Text size="xs" c="dimmed">
                Workspace
              </Text>
            </div>
          </Group>
          <Select
            label="Repository scope"
            aria-label="Repository scope"
            data={[
              { value: "all", label: "All repositories" },
              ...projects.map((project) => ({
                value: project.id,
                label: repositoryName(project),
              })),
            ]}
            value={route.projectId || "all"}
            onChange={selectRepository}
            searchable
            allowDeselect={false}
            nothingFoundMessage="No repositories found"
          />
          <nav aria-label="Main navigation">
            {navigation.map((item) => (
              <NavLink
                key={item.page}
                active={page === item.page}
                label={item.label}
                leftSection={<item.icon size={20} strokeWidth={1.7} aria-hidden />}
                onClick={() => navigatePage(item.page)}
              />
            ))}
          </nav>
          <Stack gap="xs" mt="auto">
            <Badge
              color={errors.length ? "orange" : lastRefresh ? "teal" : "gray"}
              variant="light"
            >
              {errors.length
                ? "Connection degraded"
                : lastRefresh
                  ? "API responding"
                  : "Connecting"}
            </Badge>
            <Text size="xs" c="dimmed">
              Last successful response
              <br />
              {formatTime(lastRefresh)}
            </Text>
          </Stack>
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <Stack gap="md">
          <div className="mobile-scope">
            <Text size="xs" c="dimmed">
              Scope: {scopeName} · change scope in navigation
            </Text>
          </div>
          {route.projectId && folders.data && !project && (
            <Alert color="red" title="Repository not found">
              Repository '{route.projectId}' is not registered. Select another
              repository or All repositories.
            </Alert>
          )}
          {errors.some(
            (resource) =>
              resource.error instanceof api.ApiError &&
              resource.error.status === 401,
          ) && (
            <Alert color="red" title="Session expired" role="alert">
              The dashboard rejected authentication. Reopen the dashboard using
              its authenticated URL, then refresh.
            </Alert>
          )}
          {required.map(([name, resource]) => (
            <ResourceFeedback key={name} name={name} resource={resource} />
          ))}
          {page === "home" && executions.data && (
            <>
              <Overview
                executions={executions.data}
                projects={projects}
                scope={project}
                onExecution={(id) =>
                  navigate(routeForPage("executions", route.projectId, id))
                }
                onWorkflows={() => navigatePage("workflows")}
              />
              {route.page === "executions" && route.executionId && (
                <Executions
                  minimal
                  executions={executions.data}
                  workflows={workflows.data ?? []}
                  projects={projects}
                  route={route}
                  onRoute={navigate}
                  onRefresh={() => void executions.refresh()}
                />
              )}
            </>
          )}
          {page === "repositories" && folders.data && (
            <Repositories
              projects={projects}
              executions={executions.data ?? []}
              onSelect={(project) => navigate(routeForPage("home", project.id))}
              onAdd={() => setRegisterOpened(true)}
              onRefresh={refresh}
              onRemoved={(id) => {
                if (route.projectId === id)
                  navigate(routeForPage("repositories"));
              }}
            />
          )}
          {page === "workflows" &&
            (route.projectId ? (
              project &&
              workflows.data &&
              config.data &&
              catalog.data && (
                <Workflows
                  key={project.id}
                  workflows={workflows.data}
                  config={config.data.config}
                  catalog={catalog.data}
                  project={project}
                  selectedWorkflowId={route.workflowId}
                  onSelectWorkflow={(id) =>
                    navigate(routeForPage("workflows", project.id, id))
                  }
                  onSaved={() => {
                    void config.refresh();
                    void workflows.refresh();
                  }}
                  onDirtyChange={onDirtyChange}
                  onBusyChange={setOperationBusy}
                />
              )
            ) : (
              <Stack>
                <Alert title="Choose a repository to author workflows">
                  Workflow edits must target a named repository. Select one in
                  Repository scope.
                </Alert>
                {(workflows.data ?? []).map((workflow: any) => (
                  <Button
                    key={`${workflow.projectFolderId}:${workflow.id}`}
                    variant="default"
                    onClick={() =>
                      navigate(
                        routeForPage(
                          "workflows",
                          workflow.projectFolderId || workflow.projectId,
                          workflow.id,
                        ),
                      )
                    }
                  >
                    {workflow.id} ·{" "}
                    {projects.find(
                      (project) =>
                        project.id ===
                        (workflow.projectFolderId || workflow.projectId),
                    )?.displayName ||
                      workflow.projectFolderId ||
                      workflow.projectId ||
                      "Repository not recorded"}
                  </Button>
                ))}
              </Stack>
            ))}
          {page === "executions" && executions.data && (
            <Executions
              executions={executions.data}
              workflows={workflows.data ?? []}
              projects={projects}
              route={route}
              onRoute={navigate}
              onRefresh={() => void executions.refresh()}
            />
          )}
          {page === "workers" && workers.data && (
            <Workers
              key={scopeKey}
              workers={workers.data}
              projects={projects}
              project={project}
              onRefresh={() => void workers.refresh()}
            />
          )}
        </Stack>
      </AppShell.Main>
      <RegisterDialog
        opened={registerOpened}
        onClose={() => setRegisterOpened(false)}
        onAdded={async (project) => {
          await folders.refresh();
          setSelectedRepository(project.id);
          persistSelectedRepository(project.id);
          navigate(routeForPage("home", project.id));
        }}
      />
      <Modal
        opened={Boolean(pendingRoute)}
        onClose={() => setPendingRoute(undefined)}
        title="Unsaved workflow changes"
      >
        <Stack>
          <Text size="sm">
            Leave this workflow and discard its unsaved changes?
          </Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => setPendingRoute(undefined)}
            >
              Keep editing
            </Button>
            <Button
              color="red"
              onClick={() => {
                const next = pendingRoute;
                dirty.current = false;
                setPendingRoute(undefined);
                if (next) commitRoute(next);
              }}
            >
              Discard and leave
            </Button>
          </Group>
        </Stack>
      </Modal>
    </AppShell>
  );
}

export default function App() {
  return (
    <MantineProvider theme={dashboardTheme} forceColorScheme="light">
      <ReactFlowProvider>
        <Dashboard />
      </ReactFlowProvider>
    </MantineProvider>
  );
}
