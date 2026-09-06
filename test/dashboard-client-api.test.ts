import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  getCatalog,
  getConfig,
  getExecutions,
  getPlugins,
  getProjects,
  getPrompts,
  testWorkflowDraft,
  getWatcherStatuses,
  getWorkers,
  getWorkflows,
  request,
} from "../src/dashboard/client/api.js";
import { retryEligibility } from "../src/dashboard/global-server.js";

const fetchMock = vi.fn();
const project = { id: "repo-1", root: "/tmp/repo" };

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function failing(status: number, message = `failure-${status}`): void {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
}

describe("dashboard API error contracts", () => {
  it.each([
    ["projects", () => getProjects(), "/api/projects"],
    ["watchers", () => getWatcherStatuses(), "/api/supervisor"],
    ["scoped workflows", () => getWorkflows(project), "/api/projects/repo-1/workflows"],
    ["scoped executions", () => getExecutions(project), "/api/executions?folderId=repo-1"],
    ["scoped workers", () => getWorkers(project), "/api/projects/repo-1/workers"],
    ["scoped plugins", () => getPlugins(project), "/api/projects/repo-1/plugins"],
    ["scoped prompts", () => getPrompts(project), "/api/projects/repo-1/prompts"],
    ["scoped config", () => getConfig(project), "/api/projects/repo-1/config/json"],
  ])("preserves a 401 instead of returning a fake empty %s", async (_name, call, path) => {
    failing(401, "session expired");
    await expect(call()).rejects.toMatchObject({ status: 401, path, message: "session expired" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a server error and endpoint context", async () => {
    failing(500, "database unavailable");
    await expect(getWorkflows(project)).rejects.toEqual(expect.objectContaining({
      name: "ApiError",
      status: 500,
      path: "/api/projects/repo-1/workflows",
      method: "GET",
      message: "database unavailable",
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed successful JSON instead of passing an error object downstream", async () => {
    fetchMock.mockResolvedValue(new Response("not-json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getProjects()).rejects.toMatchObject({ status: 502, path: "/api/projects" });
  });

  it.each([
    ["projects", () => getProjects(), "/api/projects"],
    ["supervisor", () => getWatcherStatuses(), "/api/supervisor"],
    ["workflows", () => getWorkflows(project), "/api/projects/repo-1/workflows"],
    ["executions", () => getExecutions(project), "/api/executions?folderId=repo-1"],
    ["workers", () => getWorkers(project), "/api/projects/repo-1/workers"],
  ])("rejects an invalid successful %s shape", async (_name, call, path) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(call()).rejects.toMatchObject({ status: 502, path });
  });

  it("keeps optional model discovery diagnostics explicit", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemas: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Codex is unavailable" }), { status: 501 }));
    const catalog = await getCatalog(project);
    expect(catalog.modelAvailability).toMatchObject({ available: false, error: { status: 501, path: "/api/projects/repo-1/codex/models" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not hide authentication failure from optional model discovery", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemas: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "session expired" }), { status: 401 }));
    await expect(getCatalog(project)).rejects.toMatchObject({ status: 401, path: "/api/projects/repo-1/codex/models" });
  });

  it("rejects a legacy saved-preview response as draft preview", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, output: "saved workflow" }), { status: 200 }));
    await expect(testWorkflowDraft("delivery", { enabled: true }, project)).rejects.toMatchObject({
      status: 501,
      path: "/api/projects/repo-1/workflows/delivery/test",
    });
  });

  it("aborts a request at the optional timeout with a typed error", async () => {
    vi.stubGlobal("fetch", vi.fn((_path: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })));
    await expect(request("/api/slow", { timeoutMs: 1 })).rejects.toMatchObject({ status: 408, path: "/api/slow", method: "GET" });
  });

  it("applies the timeout while reading the response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    })));
    await expect(request("/api/slow-body", { timeoutMs: 1 })).rejects.toMatchObject({ status: 408, path: "/api/slow-body" });
  });

  it("exposes ApiError as an Error for existing consumers", async () => {
    failing(404);
    try {
      await getProjects();
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("dashboard retry eligibility", () => {
  it("allows only failed and legacy timed_out jobs and never completed jobs", () => {
    const result = retryEligibility({
      failed: { status: "failed" },
      timed: { status: "timed_out" },
      done: { status: "succeeded" },
      skipped: { status: "skipped" },
      running: { status: "started" },
      uncertain: { status: "failed", needsAttention: true },
    });
    expect(result.eligible).toEqual(["failed", "timed"]);
    expect(result.ineligible).toEqual(expect.arrayContaining([
      { id: "done", status: "succeeded", reason: "only failed or timed_out jobs can be retried" },
      { id: "uncertain", status: "failed", reason: "attempt requires manual inspection before retry" },
    ]));
  });

  it("reports selected completed jobs without partially replaying them", () => {
    expect(retryEligibility({ failed: { status: "failed" }, done: { status: "succeeded" } }, ["done"]))
      .toEqual({ eligible: [], ineligible: [{ id: "done", status: "succeeded", reason: "only failed or timed_out jobs can be retried" }] });
  });

  it("keeps a future scheduled retry authoritative", () => {
    expect(retryEligibility({ failed: { status: "failed", retryAt: "2026-09-07T10:00:00Z" } }, undefined, "2026-09-06T10:00:00Z"))
      .toEqual({ eligible: [], ineligible: [{ id: "failed", status: "failed", reason: "job is scheduled for retry at 2026-09-07T10:00:00Z" }] });
  });
});
