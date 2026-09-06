import { describe, expect, it } from "vitest";
import { workItems } from "../src/dashboard/client/work-items.js";

describe("dashboard Work list", () => {
  it("shows only the newest actionable execution for a ticket", () => {
    const items = workItems([
      {
        id: "old-run",
        status: "running",
        projectFolderId: "repo-a",
        item: { id: "NOT-337" },
        updatedAt: "2026-09-02T10:00:00.000Z",
      },
      {
        id: "new-run",
        status: "running",
        projectFolderId: "repo-a",
        item: { id: "NOT-337" },
        updatedAt: "2026-09-04T10:00:00.000Z",
      },
      {
        id: "failed-run",
        status: "failed",
        projectFolderId: "repo-a",
        item: { id: "NOT-336" },
        updatedAt: "2026-09-03T10:00:00.000Z",
      },
      {
        id: "complete-run",
        status: "succeeded",
        projectFolderId: "repo-a",
        item: { id: "NOT-338" },
        updatedAt: "2026-09-05T10:00:00.000Z",
      },
    ]);

    expect(items.map((item) => item.id)).toEqual(["new-run", "failed-run"]);
  });

  it("keeps a waiting execution even when its parent has no active status", () => {
    expect(
      workItems([
        {
          id: "waiting-run",
          status: "succeeded",
          projectFolderId: "repo-a",
          item: { id: "NOT-339" },
          jobs: { agent: { status: "waiting" } },
        },
      ]),
    ).toHaveLength(1);
  });
});
