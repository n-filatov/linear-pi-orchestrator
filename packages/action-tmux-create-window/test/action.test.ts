import { describe, expect, it } from "vitest";
import { tmuxCreateWindowConfigSchema } from "../src/index.js";
describe("tmux create-window action", () => it("keeps the ticket-only default and validates templates", () => {
  expect(tmuxCreateWindowConfigSchema.parse(undefined)).toEqual({});
  expect(tmuxCreateWindowConfigSchema.parse({ windowNameTemplate: "{{item.id}}-{{item.title}}" })).toHaveProperty("windowNameTemplate");
  expect(() => tmuxCreateWindowConfigSchema.parse({ windowNameTemplate: " " })).toThrow();
  expect(() => tmuxCreateWindowConfigSchema.parse({ pane: "unsafe" })).toThrow();
}));

import { vi } from "vitest";
import { createTmuxCreateWindowAction } from "../src/index.js";
import type { ActionContext } from "@task-relay/plugin-sdk";

it("renders the name without escaping the title or treating it as another template", async () => {
  const launch = vi.fn(async () => ({ status: "succeeded" }));
  const context = { item: { id: "CRM-615", title: "Admin & team {{settings}}" }, workers: { launch } } as unknown as ActionContext;
  const action = createTmuxCreateWindowAction({ harnessId: "tmux" });
  await action.execute(context, { windowNameTemplate: "{{item.id}}-{{item.title}}" });
  expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ harnessInput: { windowName: "CRM-615-Admin & team {{settings}}" } }));
  await action.execute({ ...context, inputsResolved: true }, { windowNameTemplate: "CRM-615-Admin & team {{settings}}" });
  expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ harnessInput: { windowName: "CRM-615-Admin & team {{settings}}" } }));
});
