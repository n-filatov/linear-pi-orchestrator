import { describe, expect, it } from "vitest";
import { rejectedResource, resolvedResource } from "../src/dashboard/client/resource.js";

describe("dashboard resource outcomes", () => {
  it("distinguishes a successful empty collection from a failed initial request", () => {
    expect(resolvedResource("executions:a", [])).toMatchObject({ status: "empty", data: [] });
    const failed = rejectedResource({ key: "executions:a", status: "loading", refreshing: true }, new Error("Unauthorized"));
    expect(failed.status).toBe("error");
    expect(failed.data).toBeUndefined();
  });

  it("retains successful data and its original timestamp after a refresh fails", () => {
    const previous = resolvedResource("watchers", [{ projectId: "a", state: "running" }]);
    const failed = rejectedResource(previous, new Error("server unavailable"));
    expect(failed).toMatchObject({ status: "stale", data: previous.data, refreshedAt: previous.refreshedAt, refreshing: false });
    expect(failed.error?.message).toBe("server unavailable");
    expect(previous.status).toBe("success");
  });

  it("clears old errors after the resource recovers", () => {
    const failed = rejectedResource(resolvedResource("workers", []), "timeout");
    expect(failed.status).toBe("stale");
    expect(resolvedResource(failed.key, [{ id: "worker-1" }])).toMatchObject({ status: "success", data: [{ id: "worker-1" }] });
    expect(resolvedResource(failed.key, [])).not.toHaveProperty("error");
  });
});
