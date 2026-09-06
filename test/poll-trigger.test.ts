import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pollingTriggerSource } from "../src/application/poll-trigger.js";
import { RepositoryStateStore } from "../src/state/store.js";
import type { TriggerPlugin } from "../src/plugins/index.js";
import { z } from "zod";

const repository = { id: "repo", root: "/repo" };
const trigger = { id: "binding", sourceId: "fixture", repository, enabled: true };

function plugin(poll: TriggerPlugin<unknown, { title: string; value: number }, string>["poll"]): TriggerPlugin<unknown, { title: string; value: number }, string> {
  return {
    kind: "trigger", use: "fixture", apiVersion: 1, configSchema: z.object({}),
    payloadSchema: z.object({ title: z.string(), value: z.number() }), cursorSchema: z.string(), poll,
    } as TriggerPlugin<unknown, { title: string; value: number }, string>;
}

describe("polling trigger compatibility adapter", () => {
  it("persists cursor and deduplicates the same event after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-trigger-"));
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    const store = new RepositoryStateStore(root);
    let calls = 0;
    const poll = vi.fn(async ({ cursor }: { cursor?: string; bindingId: string; repository: { id: string; root: string }; signal?: AbortSignal }) => {
      calls += 1;
      return { events: cursor ? [] : [{ id: "event-1", subject: "ENG-1", observedAt: "2026-09-05T10:00:00Z", payload: { title: "One", value: 1 } }], cursor: "cursor-1" };
    });
    const source = pollingTriggerSource("fixture", plugin(poll), {}, { ...repository, root }, store);
    const first = await source.discover({ trigger: { ...trigger, repository: { ...repository, root } } });
    expect(first).toHaveLength(1);
    await source.acknowledge?.(first[0]);
    expect(await source.discover({ trigger: { ...trigger, repository: { ...repository, root } } })).toHaveLength(0);
    await source.close?.();

    const restarted = pollingTriggerSource("fixture", plugin(poll), {}, { ...repository, root }, store);
    expect(await restarted.discover({ trigger: { ...trigger, repository: { ...repository, root } } })).toHaveLength(0);
    expect(calls).toBe(3);
    store.close();
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousStateHome;
  });

  it("keeps accepted pending events when polling fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-trigger-offline-"));
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    const store = new RepositoryStateStore(root);
    const poll = vi.fn(async () => { throw new Error("offline"); });
    const source = pollingTriggerSource("fixture", plugin(poll), {}, { ...repository, root }, store);
    const bindingId = JSON.stringify([repository.id, root, trigger.id, "fixture"]);
    await store.acceptTriggerEvents(bindingId, [{
      id: "queued", bindingId, subjectKey: "ENG-2", observedAt: "2026-09-05T10:00:00Z", payload: { title: "Two", value: 2 }, status: "pending",
    }], "cursor-0", new Date().toISOString());
    expect(await source.discover({ trigger: { ...trigger, repository: { ...repository, root } } })).toHaveLength(1);
    store.close();
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousStateHome;
  });
});
