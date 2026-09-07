import { describe, expect, it } from "vitest";
import { codexStartSessionConfigSchema } from "../src/index.js";
describe("Codex start-session action", () => it("starts without a prompt", () => {
  expect(codexStartSessionConfigSchema.parse({})).toEqual({});
  expect(codexStartSessionConfigSchema.parse({ prompt: "implement" })).not.toHaveProperty("prompt");
}));

import { execFileSync } from "node:child_process";
import { vi } from "vitest";
import { createCodexStartSessionAction } from "../src/index.js";
import type { ActionContext } from "@task-relay/plugin-sdk";

it("passes permissions to the server and quotes attached terminal arguments", async () => {
  const permissions = { sandbox: "workspace-write" as const, approvals: "on-request" as const, networkAccess: true, writableRoots: ["/tmp/Nikita's workspace"] };
  const launch = vi.fn(async (_input: unknown) => ({ status: "succeeded", output: { endpoint: "ws://127.0.0.1:1234", threadId: "thread-1" } }));
  const send = vi.fn(async (_target: unknown, _input: unknown) => ({ status: "succeeded" }));
  const context = {
    repository: { root: "/tmp/repo" }, inputsResolved: true,
    workers: { launch, send, recordOutputs: vi.fn(), resolve: async () => [{ worker: { id: "terminal", metadata: { tmux: { session: "relay", target: "%7" } } } }] },
  } as unknown as ActionContext;
  const action = createCodexStartSessionAction({ codexAppServer: {}, harnessId: "codex", readPromptFile: async () => "" });
  await action.execute(context, codexStartSessionConfigSchema.parse({ prompt: "hello", tmux: { action: "terminal" }, permissions }));
  expect(launch.mock.calls[0]?.[0]).toMatchObject({ prompt: "", harnessInput: { permissions, startOnly: true } });
  const command = (send.mock.calls[0] as unknown as [unknown, { text: string }])[1].text;
  // Parse using a real POSIX shell but replace codex with an argument printer.
  const args = execFileSync("/bin/sh", ["-c", 'codex() { printf "%s\\n" "$@"; }; ' + command], { encoding: "utf8" });
  expect(args).toContain('--sandbox\nworkspace-write\n--ask-for-approval\non-request\n');
  expect(args).toContain('sandbox_workspace_write.writable_roots=["/tmp/Nikita\'s workspace"]');
});
