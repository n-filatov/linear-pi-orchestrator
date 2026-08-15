import Table from "cli-table3";
import type { RelayEvent } from "./events.js";

export function statusTable(rows: Array<[string, string | number | boolean | undefined]>): string {
  const table = new Table({ chars: { "top": "", "top-mid": "", "top-left": "", "top-right": "", "bottom": "", "bottom-mid": "", "bottom-left": "", "bottom-right": "", "left": "", "left-mid": "", "mid": "", "mid-mid": "", "right": "", "right-mid": "", "middle": " " }, style: { "padding-left": 0, "padding-right": 2, head: [] } });
  for (const [key, value] of rows) table.push([key, value === undefined ? "—" : String(value)]);
  return table.toString();
}

export function eventsTable(events: RelayEvent[]): string {
  const table = new Table({ head: ["Time", "Level", "Trigger", "Task", "Agent / model", "Event", "Duration"], colWidths: [25, 8, 18, 22, 28, 26, 11], wordWrap: true });
  for (const event of events) table.push([
    event.timestamp?.replace("T", " ").replace(/\.\d+Z$/, "") || "—", event.level || "info", event.trigger || "—", event.task || "—",
    [event.agent, event.model].filter(Boolean).join(" / ") || "—", event.error || event.event, event.duration === undefined ? "—" : `${event.duration}ms`,
  ]);
  return table.toString();
}

export function errorTable(events: RelayEvent[]): string {
  const table = new Table({ head: ["Time", "Run", "Task", "Error"], colWidths: [25, 22, 24, 74], wordWrap: true });
  for (const event of events) table.push([event.timestamp || "—", event.runId || "—", event.task || "—", event.error || event.event]);
  return table.toString();
}
