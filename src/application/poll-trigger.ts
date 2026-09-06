import type { TriggerPlugin } from "../plugins/index.js";
import type { RepositoryScope, WorkItem, WorkSource } from "../domain/index.js";
import type { RepositoryStateStore, JsonValue } from "../state/store.js";

/** Compatibility transport from durable trigger occurrences to the existing workflow boundary. */
export function pollingTriggerSource(
  sourceId: string, plugin: TriggerPlugin, config: unknown,
  repository: RepositoryScope,
  store: Pick<RepositoryStateStore, "getTriggerCheckpoint" | "acceptTriggerEvents" | "listPendingTriggerEvents" | "acknowledgeTriggerEvent">,
  options: { clock?: () => Date; readOnly?: boolean } = {},
): WorkSource {
  const clock = options.clock ?? (() => new Date());
  return {
    id: sourceId,
    async discover({ trigger, signal }) {
      const bindingId = JSON.stringify([repository.id, repository.root, trigger.id, sourceId]);
      const storedCursor = await store.getTriggerCheckpoint(bindingId);
      const cursor = storedCursor === undefined ? undefined : plugin.cursorSchema.parse(storedCursor);
      let polledEvents: import("../state/store.js").TriggerEventRecord[] = [];
      try {
        const polled = await plugin.poll({ bindingId, repository, cursor, signal }, config);
        const nextCursor = polled.cursor === undefined ? undefined : plugin.cursorSchema.parse(polled.cursor);
        const events = polled.events.map((event) => {
          if (!event.id || !event.subject || !Number.isFinite(Date.parse(event.observedAt))) throw new Error(`Trigger '${plugin.use}' returned an invalid event identity or timestamp.`);
          return { id: JSON.stringify([bindingId, event.id]), bindingId, subjectKey: event.subject,
            observedAt: event.observedAt, payload: plugin.payloadSchema.parse(event.payload) as JsonValue,
            status: "pending" as const };
        });
        polledEvents = events;
        if (!options.readOnly) await store.acceptTriggerEvents(bindingId, events, nextCursor, clock().toISOString());
      } catch (error) {
        // Already accepted events remain actionable when the provider is offline.
        if (!(await store.listPendingTriggerEvents(bindingId)).length) throw error;
      }
      const pending = options.readOnly ? polledEvents : await store.listPendingTriggerEvents(bindingId);
      return pending.map((event): WorkItem => {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
        return { sourceId, id: event.subjectKey, title: typeof payload.title === "string" ? payload.title : event.subjectKey,
          description: typeof payload.description === "string" ? payload.description : undefined,
          triggerEvent: { id: event.id, payload: event.payload } };
      });
    },
    async acknowledge(item) { if (item.triggerEvent) await store.acknowledgeTriggerEvent(item.triggerEvent.id, "accepted"); },
    async report() {},
    async close() { await plugin.close?.(); },
  };
}
