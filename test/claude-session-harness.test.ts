import { chmodSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeSessionHarness, CLAUDE_SESSION_HARNESS_ID } from "../src/claude/session-harness.js";
import type { HarnessLaunchRequest } from "../src/plugins/index.js";
import type { WorkerHandle } from "../src/domain/index.js";

/**
 * Writes a fake `claude` executable that records every invocation's argv and
 * cwd to `argvLog`, then prints scripted stream-json lines to stdout. Real
 * `claude`, `open`, and `git` are never invoked by these tests.
 */
function writeFakeClaude(binDir: string, argvLog: string, body: string): string {
  const script = join(binDir, "claude");
  writeFileSync(script, `#!/usr/bin/env bash\nset -e\nprintf '%s\\n' "$*" >> "${argvLog}"\n${body}\n`);
  chmodSync(script, 0o755);
  return script;
}

const succeedBody = `
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"cwd\\":\\"$(pwd)\\",\\"session_id\\":\\"test\\"}"
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"All done\\",\\"total_cost_usd\\":0.02,\\"duration_ms\\":150}"
`;

const failBody = `
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"cwd\\":\\"$(pwd)\\",\\"session_id\\":\\"test\\"}"
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"error_during_execution\\",\\"is_error\\":true,\\"result\\":\\"It broke\\"}"
`;

// Sleeps long enough that a test can observe the "running" state and exercise
// stop/kill before it ever prints a result line.
const hangBody = `
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"cwd\\":\\"$(pwd)\\",\\"session_id\\":\\"test\\"}"
trap 'exit 0' TERM
sleep 30
`;

// Prints its result line immediately, then keeps the process alive for a
// moment before exiting -- mirrors the real `claude -p` process, which stays
// registered in ~/.claude/sessions/<pid>.json for a beat after it emits its
// result.
const resultThenLingerBody = `
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"cwd\\":\\"$(pwd)\\",\\"session_id\\":\\"test\\"}"
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"All done\\",\\"total_cost_usd\\":0.02,\\"duration_ms\\":150}"
sleep 1
`;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function launchRequest(overrides: Partial<HarnessLaunchRequest<Record<string, unknown>>> = {}): HarnessLaunchRequest<Record<string, unknown>> {
  return {
    workerId: "worker-1",
    repository: { id: "repo", root: "/repo" },
    item: { sourceId: "linear", id: "REL-1", title: "Relay task" },
    workspace: { path: process.cwd() },
    prompt: "",
    config: {},
    harnessInput: { worktree: "REL-1", name: "REL-1 Relay task", permissionMode: "auto" },
    ...overrides,
  };
}

describe("ClaudeSessionHarness", () => {
  let root: string;
  let binDir: string;
  let stateDirectory: string;
  let sessionsDirectory: string;
  let argvLog: string;
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-harness-"));
    binDir = join(root, "bin");
    stateDirectory = join(root, "state");
    sessionsDirectory = join(root, "sessions");
    argvLog = join(root, "argv.log");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(sessionsDirectory, { recursive: true });
    writeFileSync(argvLog, "");
    cleanupDirs.push(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function harness(overrides: Partial<ConstructorParameters<typeof ClaudeSessionHarness>[0]> = {}) {
    return new ClaudeSessionHarness({
      stateDirectory,
      sessionsDirectory,
      command: join(binDir, "claude"),
      openUrl: vi.fn(async () => undefined),
      platform: "darwin",
      sleep: async () => undefined,
      runGit: vi.fn(async () => undefined),
      handoffSpacingMs: 0,
      ...overrides,
    });
  }

  function readArgvLines(): string[][] {
    return readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/));
  }

  function readSessionRecord(workerId: string): { turns: Record<string, { pid: number }> } {
    return JSON.parse(readFileSync(join(stateDirectory, "claude-sessions", workerId, "session.json"), "utf8"));
  }

  it("has the reserved harness id", () => {
    expect(CLAUDE_SESSION_HARNESS_ID).toBe("__claude_session");
  });

  describe("launch", () => {
    it("persists session state without spawning a process", async () => {
      const instance = harness();
      const worker = await instance.launch(launchRequest());
      expect(worker.id).toBe("worker-1");
      expect(worker.metadata).toMatchObject({
        persistent: true,
        claudeSession: expect.objectContaining({ worktree: "REL-1", name: "REL-1 Relay task", permissionMode: "auto" }),
      });
      const sessionId = (worker.metadata!.claudeSession as { sessionId: string }).sessionId;
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const persisted = JSON.parse(readFileSync(join(stateDirectory, "claude-sessions", "worker-1", "session.json"), "utf8"));
      expect(persisted.sessionId).toBe(sessionId);
      expect(readFileSync(argvLog, "utf8")).toBe("");
    });
  });

  describe("sendPrompt + turn lifecycle", () => {
    it("starts a turn that reports running, then succeeded, using --worktree/--session-id/--name on the first turn", async () => {
      writeFakeClaude(binDir, argvLog, succeedBody);
      const instance = harness();
      const worker = await instance.launch(launchRequest());

      const started = await instance.sendPrompt(worker, { prompt: "Implement it", model: "sonnet", jsonSchema: { type: "object" } });
      expect(started.status).toBe("running");

      let turn = await instance.turn(worker, started.turnId);
      await waitFor(async () => (turn = await instance.turn(worker, started.turnId)).status !== "running");
      expect(turn.status).toBe("succeeded");
      expect(turn.result).toBe("All done");
      expect(turn.costUsd).toBe(0.02);
      expect(turn.durationMs).toBe(150);

      const args = readArgvLines()[0]!;
      expect(args).toContain("--worktree");
      expect(args).toContain("--session-id");
      expect(args).toContain("--name");
      expect(args).not.toContain("--resume");
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
      expect(args).toContain("--permission-mode");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(args.join(" ")).toContain("--permission-prompts none");
      expect(args).toContain("--json-schema");
    });

    it("resumes with --resume on a later turn instead of --worktree/--session-id/--name", async () => {
      writeFakeClaude(binDir, argvLog, succeedBody);
      const instance = harness();
      const worker = await instance.launch(launchRequest());
      const first = await instance.sendPrompt(worker, { prompt: "First" });
      await waitFor(async () => (await instance.turn(worker, first.turnId)).status !== "running");

      const second = await instance.sendPrompt(worker, { prompt: "Second" });
      await waitFor(async () => (await instance.turn(worker, second.turnId)).status !== "running");

      const secondArgs = readArgvLines()[1]!;
      expect(secondArgs).toContain("--resume");
      expect(secondArgs).not.toContain("--worktree");
      expect(secondArgs).not.toContain("--session-id");
      expect(secondArgs).not.toContain("--name");
    });

    it("reports a failed turn from an error result line", async () => {
      writeFakeClaude(binDir, argvLog, failBody);
      const instance = harness();
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Break it" });
      let turn = await instance.turn(worker, started.turnId);
      await waitFor(async () => (turn = await instance.turn(worker, started.turnId)).status !== "running");
      expect(turn.status).toBe("failed");
      expect(turn.error).toBe("It broke");
    });

    it("refuses to start a turn while one is already running", async () => {
      writeFakeClaude(binDir, argvLog, hangBody);
      const instance = harness();
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Long running" });
      await waitFor(async () => (await instance.turn(worker, started.turnId)).status === "running");

      await expect(instance.sendPrompt(worker, { prompt: "Second" })).rejects.toThrow(/already has a running/);
      await instance.stop(worker);
    });

    it("keeps reporting running once a result line appears until the process actually exits", async () => {
      writeFakeClaude(binDir, argvLog, resultThenLingerBody);
      const instance = harness();
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Implement it" });

      // The result line lands almost immediately, but the fake process lingers
      // for ~1s afterward; the turn must not be marked finished until it exits.
      await waitFor(async () => {
        const pid = readSessionRecord(worker.id).turns[started.turnId]!.pid;
        return isAlive(pid) && readFileSync(
          JSON.parse(readFileSync(join(stateDirectory, "claude-sessions", worker.id, "session.json"), "utf8")).turns[started.turnId].log,
          "utf8",
        ).includes("\"type\":\"result\"");
      });
      const pid = readSessionRecord(worker.id).turns[started.turnId]!.pid;
      expect(isAlive(pid)).toBe(true);
      const stillRunning = await instance.turn(worker, started.turnId);
      expect(stillRunning.status).toBe("running");

      await waitFor(() => !isAlive(pid));
      let turn = await instance.turn(worker, started.turnId);
      await waitFor(async () => (turn = await instance.turn(worker, started.turnId)).status !== "running");
      expect(turn.status).toBe("succeeded");
      expect(turn.result).toBe("All done");
    });
  });

  describe("stop", () => {
    it("kills a running turn's process", async () => {
      writeFakeClaude(binDir, argvLog, hangBody);
      const instance = harness({ killGraceMs: 0 });
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Long running" });
      await waitFor(async () => (await instance.turn(worker, started.turnId)).status === "running");
      const pid = readSessionRecord(worker.id).turns[started.turnId]!.pid;
      expect(isAlive(pid)).toBe(true);

      await instance.stop(worker);
      await waitFor(() => !isAlive(pid));
      expect(isAlive(pid)).toBe(false);
    });
  });

  describe("handoff", () => {
    async function launchAndFinishTurn(instance: ClaudeSessionHarness): Promise<WorkerHandle> {
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Implement it" });
      await waitFor(async () => (await instance.turn(worker, started.turnId)).status !== "running");
      return worker;
    }

    it("hands the session off and returns a claude:// resume link", async () => {
      writeFakeClaude(binDir, argvLog, succeedBody);
      const openUrl = vi.fn(async (_url: string) => undefined);
      const instance = harness({ openUrl });
      const worker = await launchAndFinishTurn(instance);

      const result = await instance.handoff(worker);
      expect(result.target).toBe("claude-app");
      expect(result.chainStatus).toBe("succeeded");
      expect(result.lastResult).toBe("All done");
      expect(typeof result.link).toBe("string");
      expect(openUrl).toHaveBeenCalledTimes(1);
      const [url] = openUrl.mock.calls[0]!;
      expect(url).toMatch(/^claude:\/\/resume\?session=[0-9a-f-]{36}$/);
      expect(result.link).toContain(`local_`);
    });

    it("refuses to hand off a worker with a running turn unless forced", async () => {
      writeFakeClaude(binDir, argvLog, hangBody);
      const openUrl = vi.fn(async () => undefined);
      const instance = harness({ openUrl, killGraceMs: 0 });
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Long running" });
      await waitFor(async () => (await instance.turn(worker, started.turnId)).status === "running");

      await expect(instance.handoff(worker)).rejects.toThrow(/turn in progress/);
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("force kills a running turn before handing off", async () => {
      writeFakeClaude(binDir, argvLog, hangBody);
      const openUrl = vi.fn(async () => undefined);
      const instance = harness({ openUrl, killGraceMs: 0 });
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Long running" });
      await waitFor(async () => (await instance.turn(worker, started.turnId)).status === "running");

      const result = await instance.handoff(worker, { force: true });
      expect(result.target).toBe("claude-app");
      expect(openUrl).toHaveBeenCalledTimes(1);
    });

    it("reports a succeeded chain when a forced handoff kills the only running turn and no other turn failed", async () => {
      writeFakeClaude(binDir, argvLog, hangBody);
      const openUrl = vi.fn(async () => undefined);
      const instance = harness({ openUrl, killGraceMs: 0 });
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Long running" });
      await waitFor(async () => (await instance.turn(worker, started.turnId)).status === "running");

      // The turn in flight is cancelled by the takeover, not failed by Claude,
      // so it must not sour the chain outcome the desktop app is handed.
      const result = await instance.handoff(worker, { force: true });
      expect(result.chainStatus).toBe("succeeded");
    });

    it("refuses to hand off while a live sessions registry entry matches this session", async () => {
      writeFakeClaude(binDir, argvLog, succeedBody);
      const openUrl = vi.fn(async () => undefined);
      const instance = harness({ openUrl });
      const worker = await launchAndFinishTurn(instance);
      const sessionId = (worker.metadata!.claudeSession as { sessionId: string }).sessionId;
      // process.pid (this test process) is guaranteed to be alive.
      writeFileSync(join(sessionsDirectory, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, status: "running" }));

      await expect(instance.handoff(worker)).rejects.toThrow(/still registered as a live CLI process/);
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("polls a live sessions registry entry and proceeds once it disappears", async () => {
      writeFakeClaude(binDir, argvLog, succeedBody);
      const openUrl = vi.fn(async () => undefined);
      let sleepCalls = 0;
      const registryFile = join(sessionsDirectory, `${process.pid}.json`);
      const instance = harness({
        openUrl,
        sleep: async () => {
          sleepCalls += 1;
          // Simulate the CLI dropping its registry entry a couple of polls in,
          // instead of the entry outliving the full 15s poll window.
          if (sleepCalls === 2) unlinkSync(registryFile);
        },
      });
      const worker = await launchAndFinishTurn(instance);
      const sessionId = (worker.metadata!.claudeSession as { sessionId: string }).sessionId;
      writeFileSync(registryFile, JSON.stringify({ pid: process.pid, sessionId, status: "running" }));

      const result = await instance.handoff(worker);
      expect(result.target).toBe("claude-app");
      expect(sleepCalls).toBe(2);
      expect(openUrl).toHaveBeenCalledTimes(1);
    });

    it("is idempotent: a second call returns the saved result without opening the URL again", async () => {
      writeFakeClaude(binDir, argvLog, succeedBody);
      const openUrl = vi.fn(async () => undefined);
      const instance = harness({ openUrl });
      const worker = await launchAndFinishTurn(instance);

      const first = await instance.handoff(worker);
      const second = await instance.handoff(worker);
      expect(second).toEqual(first);
      expect(openUrl).toHaveBeenCalledTimes(1);
    });

    it("throws on an unsupported platform without opening the URL", async () => {
      writeFakeClaude(binDir, argvLog, succeedBody);
      const openUrl = vi.fn(async () => undefined);
      const instance = harness({ openUrl, platform: "linux" });
      const worker = await launchAndFinishTurn(instance);

      await expect(instance.handoff(worker)).rejects.toThrow(/needs macOS or Windows/);
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("refuses to send a prompt once another harness instance has recorded a handoff, with no stale in-memory cache", async () => {
      writeFakeClaude(binDir, argvLog, succeedBody);
      // Two harness instances over the same on-disk state, as a CLI process and
      // a dashboard/relay process would each construct their own.
      const instanceA = harness();
      const instanceB = harness();
      const worker = await launchAndFinishTurn(instanceA);

      // instanceB's own object has never called handoff before, so this proves
      // requireSession() re-reads the file rather than trusting a cache.
      await instanceB.handoff(worker);

      await expect(instanceA.sendPrompt(worker, { prompt: "One more turn" })).rejects.toThrow(/already been handed off/);
    });
  });

  describe("reconcile", () => {
    it("returns undefined before handoff and the chain outcome after it, even from a fresh instance", async () => {
      writeFakeClaude(binDir, argvLog, succeedBody);
      const instance = harness();
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Implement it" });
      await waitFor(async () => (await instance.turn(worker, started.turnId)).status !== "running");

      expect(await instance.reconcile(worker)).toBeUndefined();

      await instance.handoff(worker);

      // A fresh instance (as after a Relay restart) reads the same on-disk state.
      const restarted = harness();
      const completion = await restarted.reconcile(worker);
      expect(completion).toEqual({ status: "succeeded" });
    });

    it("reports a failed chain when the last turn before handoff failed", async () => {
      writeFakeClaude(binDir, argvLog, failBody);
      const instance = harness();
      const worker = await instance.launch(launchRequest());
      const started = await instance.sendPrompt(worker, { prompt: "Break it" });
      await waitFor(async () => (await instance.turn(worker, started.turnId)).status !== "running");

      await instance.handoff(worker);
      const completion = await instance.reconcile(worker);
      expect(completion?.status).toBe("failed");
    });
  });
});
