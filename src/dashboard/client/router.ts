export type DashboardPage =
  | "home"
  | "repositories"
  | "workflows"
  | "executions"
  | "workers"
  | "plugins"
  | "settings";

export interface DashboardRoute {
  page: DashboardPage;
  projectId?: string;
  workflowId?: string;
  executionId?: string;
  filters?: { status?: string; workflow?: string; ticket?: string };
}

const pages = new Set<DashboardPage>([
  "home",
  "repositories",
  "workflows",
  "executions",
  "workers",
  "plugins",
  "settings",
]);

function decode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Parse browser history state without throwing on malformed deep links. */
export function parseDashboardRoute(
  pathname: string,
  search = "",
): DashboardRoute {
  const route = parsePath(pathname, search);
  if (route.page === "executions") {
    const query = new URLSearchParams(search);
    const filters = Object.fromEntries(
      ["status", "workflow", "ticket"].flatMap((key) =>
        query.get(key) ? [[key, query.get(key)!]] : [],
      ),
    );
    if (Object.keys(filters).length) route.filters = filters;
  }
  return route;
}

function parsePath(pathname: string, search = ""): DashboardRoute {
  const segments = pathname.split("/").filter(Boolean).map(decode);
  if (segments.some((segment) => segment === undefined))
    return { page: "home" };
  const values = segments as string[];
  if (values.length === 0) return { page: "home" };

  if (values[0] === "projects" && values[1]) {
    const projectId = values[1];
    const page = values[2] as DashboardPage | undefined;
    if (!page || !pages.has(page)) return { page: "home", projectId };
    if (page === "workflows")
      return values.length === 4 && values[3]
        ? { page, projectId, workflowId: values[3] }
        : values.length === 3
          ? { page, projectId }
          : { page: "home", projectId };
    if (page === "executions")
      return values.length === 4 && values[3]
        ? { page, projectId, executionId: values[3] }
        : values.length === 3
          ? { page, projectId }
          : { page: "home", projectId };
    if (values.length > 3) return { page: "home", projectId };
    return { page, projectId };
  }

  const page = values[0] as DashboardPage;
  if (!pages.has(page)) return { page: "home" };
  if (page === "workflows")
    return values.length === 2 && values[1]
      ? { page, workflowId: values[1] }
      : values.length === 1
        ? legacyProjectRoute(page, search)
        : { page: "home" };
  if (page === "executions")
    return values.length === 2 && values[1]
      ? { page, executionId: values[1] }
      : values.length === 1
        ? legacyProjectRoute(page, search)
        : { page: "home" };
  if (values.length > 1) return { page: "home" };
  // Retain a project query for links produced by older dashboard builds.
  return legacyProjectRoute(page, search);
}

function legacyProjectRoute(
  page: DashboardPage,
  search: string,
): DashboardRoute {
  const projectId = new URLSearchParams(search).get("project") ?? undefined;
  return projectId ? { page, projectId } : { page };
}

export function dashboardRoutePath(route: DashboardRoute): string {
  const prefix = route.projectId
    ? `/projects/${encodeURIComponent(route.projectId)}`
    : "";
  const page = route.page === "home" ? "" : `/${route.page}`;
  const detail =
    route.page === "workflows" && route.workflowId
      ? `/${encodeURIComponent(route.workflowId)}`
      : route.page === "executions" && route.executionId
        ? `/${encodeURIComponent(route.executionId)}`
        : "";
  const query = new URLSearchParams();
  if (route.page === "executions")
    for (const [key, value] of Object.entries(route.filters ?? {}))
      if (value) query.set(key, value);
  return (
    (`${prefix}${page}${detail}` || "/") +
    (query.size ? `?${query.toString()}` : "")
  );
}

export function routeForPage(
  page: DashboardPage,
  projectId?: string,
  detail?: string,
): DashboardRoute {
  return {
    page,
    ...(projectId ? { projectId } : {}),
    ...(page === "workflows" && detail ? { workflowId: detail } : {}),
    ...(page === "executions" && detail ? { executionId: detail } : {}),
  };
}
