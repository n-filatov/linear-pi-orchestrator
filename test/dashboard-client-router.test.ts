import { describe, expect, it } from "vitest";
import { dashboardRoutePath, parseDashboardRoute, routeForPage } from "../src/dashboard/client/router.js";

describe("dashboard client routes", () => {
  it("round trips project, workflow, and execution identifiers", () => {
    const workflow = routeForPage("workflows", "repo/one", "build & test");
    expect(dashboardRoutePath(workflow)).toBe("/projects/repo%2Fone/workflows/build%20%26%20test");
    expect(parseDashboardRoute(dashboardRoutePath(workflow))).toEqual(workflow);

    const execution = routeForPage("executions", "repo/one", "run/42");
    expect(parseDashboardRoute(dashboardRoutePath(execution))).toEqual(execution);
  });

  it("supports global pages and legacy project query links", () => {
    expect(parseDashboardRoute("/")).toEqual({ page: "home" });
    expect(parseDashboardRoute("/plugins")).toEqual({ page: "plugins" });
    expect(parseDashboardRoute("/executions", "?project=repo-1")).toEqual({ page: "executions", projectId: "repo-1" });
    expect(parseDashboardRoute("/workflows", "?project=repo-1")).toEqual({ page: "workflows", projectId: "repo-1" });
  });

  it("falls back safely for unknown or malformed paths", () => {
    expect(parseDashboardRoute("/unknown/page")).toEqual({ page: "home" });
    expect(parseDashboardRoute("/projects/repo/unknown")).toEqual({ page: "home", projectId: "repo" });
    expect(parseDashboardRoute("/%E0%A4%A")).toEqual({ page: "home" });
  });
});
