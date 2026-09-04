import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createRuntimeHandlers } from "../src/app.js";
import { createRelayProgram } from "../src/cli/program.js";
import { loadRelayConfig } from "../src/config/load.js";
import { normalizeRelayConfig } from "../src/config/v2.js";
import { loadReusableWorkflow } from "../src/config/reusable.js";
import { domainWorkflow } from "../src/app.js";
import { RepositoryStateStore } from "../src/state/store.js";
import { decideJob, jobInstances, jobTimedOut, runOutcome } from "../src/workflows/reconciler.js";
import { RelayExpressionError, evaluateCondition } from "../src/workflows/expressions.js";
import type { WorkflowJobDefinition, WorkflowJobState, WorkItem } from "../src/domain/index.js";

const originalStateHome = process.env.XDG_STATE_HOME;
afterEach(() => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
});

const item: WorkItem = { sourceId: "queue", id: "ENG-1", title: "Add a dev server" };

function state(status: WorkflowJobState["status"], outputs?: Record<string, unknown>): WorkflowJobState {
  return { status, attempts: 1, ...(outputs ? { outputs } : {}) };
}

function decide(job: WorkflowJobDefinition, states: Record<string, WorkflowJobState>, known = ["implement", job.id]) {
  return decideJob({ job, states, item, known: new Set(known) });
}

describe("workflow job decisions", () => {
  const dependent: WorkflowJobDefinition = { id: "review", use: "launch", needs: [{ job: "implement" }] };
  const onStarted: WorkflowJobDefinition = { id: "dev-server", use: "worker-exec", needs: [{ job: "implement", status: "started" }] };

  it("runs a job that declares no dependencies", () => {
    expect(decide({ id: "implement", use: "launch" }, {})).toEqual({ action: "run" });
  });

  it("waits for a dependency that has not finished, then runs", () => {
    expect(decide(dependent, {})).toMatchObject({ action: "hold", reason: "blocked on implement.Succeeded" });
    expect(decide(dependent, { implement: state("started") })).toMatchObject({ action: "hold" });
    expect(decide(dependent, { implement: state("succeeded") })).toEqual({ action: "run" });
    // A skipped dependency satisfies the default selector, as in Argo.
    expect(decide(dependent, { implement: state("skipped") })).toEqual({ action: "run" });
  });

  it("omits a job whose dependency can never be satisfied", () => {
    expect(decide(dependent, { implement: state("failed") })).toMatchObject({
      action: "settle", status: "omitted", reason: "implement.Succeeded can no longer be satisfied",
    });
  });

  it("separates the started edge from the finished edge", () => {
    // The dev server wants the agent's window to exist, not its work to be done.
    expect(decide(onStarted, {})).toMatchObject({ action: "hold", reason: "blocked on implement.started" });
    expect(decide(onStarted, { implement: state("started") })).toEqual({ action: "run" });
    // Once the agent exits there is no window left to split.
    expect(decide(onStarted, { implement: state("succeeded") })).toMatchObject({ action: "settle", status: "omitted" });
  });

  it("holds a job that already ran and one whose worker is still live", () => {
    expect(decide({ id: "implement", use: "launch" }, { implement: state("succeeded") })).toMatchObject({ action: "hold", reason: "already succeeded" });
    expect(decide({ id: "implement", use: "launch" }, { implement: state("started") })).toMatchObject({ action: "hold", reason: "worker is running" });
  });

  it("lets always() rescue a job after a failed dependency, and success() is the default", () => {
    const reporting: WorkflowJobDefinition = { id: "report", use: "command", needs: [{ job: "implement" }], if: "${{ always() }}" };
    expect(decide(reporting, { implement: state("failed") })).toEqual({ action: "run" });

    const guarded: WorkflowJobDefinition = { id: "report", use: "command", needs: [{ job: "implement" }], if: "${{ success() }}" };
    expect(decide(guarded, { implement: state("failed") })).toMatchObject({ action: "settle", status: "skipped" });
  });

  it("skips a job whose condition reads a dependency output as false", () => {
    const guarded: WorkflowJobDefinition = {
      id: "review", use: "launch", needs: [{ job: "implement" }],
      if: "${{ needs.implement.outputs.changed == 'true' }}",
    };
    expect(decide(guarded, { implement: state("succeeded", { changed: "false" }) })).toMatchObject({ action: "settle", status: "skipped" });
    expect(decide(guarded, { implement: state("succeeded", { changed: "true" }) })).toEqual({ action: "run" });
    // An output that was never produced reads as null rather than raising.
    expect(decide(guarded, { implement: state("succeeded") })).toMatchObject({ action: "settle", status: "skipped" });
  });

  it("omits a job that depends on a name no job in the workflow has", () => {
    const typo: WorkflowJobDefinition = { id: "review", use: "launch", needs: [{ job: "implemnt" }] };
    expect(decide(typo, {})).toMatchObject({ action: "settle", status: "omitted", reason: "needs unknown job 'implemnt'" });
  });

  it("holds a run open while any job is still pending or started", () => {
    const jobs: WorkflowJobDefinition[] = [{ id: "implement", use: "launch" }, { id: "review", use: "launch" }];
    expect(runOutcome(jobs, { implement: state("started"), review: state("succeeded") })).toEqual({ done: false, status: "succeeded" });
    expect(runOutcome(jobs, { implement: state("succeeded") })).toEqual({ done: false, status: "succeeded" });
    expect(runOutcome(jobs, { implement: state("succeeded"), review: state("skipped") })).toEqual({ done: true, status: "succeeded" });
    expect(runOutcome(jobs, { implement: state("failed"), review: state("omitted") })).toEqual({ done: true, status: "failed" });
    // continueOnError keeps a failed job from failing the whole run.
    const tolerant: WorkflowJobDefinition[] = [{ id: "implement", use: "launch", continueOnError: true }];
    expect(runOutcome(tolerant, { implement: state("failed") })).toEqual({ done: true, status: "succeeded" });
  });
});

describe("workflow expressions", () => {
  const status = { success: true, failure: false, cancelled: false };

  it("accepts both the wrapped and bare forms", () => {
    expect(evaluateCondition("${{ true }}", {}, status)).toBe(true);
    expect(evaluateCondition("true", {}, status)).toBe(true);
  });

  it("applies GitHub truthiness", () => {
    expect(evaluateCondition("''", {}, status)).toBe(false);
    expect(evaluateCondition("'x'", {}, status)).toBe(true);
    expect(evaluateCondition("0", {}, status)).toBe(false);
    expect(evaluateCondition("1", {}, status)).toBe(true);
  });

  it("exposes Relay contexts and GitHub's built-in functions", () => {
    const contexts = { item: { id: "ENG-1", metadata: { labels: ["relay:ask"] } } };
    expect(evaluateCondition("${{ item.id == 'ENG-1' }}", contexts, status)).toBe(true);
    expect(evaluateCondition("${{ contains(item.metadata.labels, 'relay:ask') }}", contexts, status)).toBe(true);
    expect(evaluateCondition("${{ contains(item.metadata.labels, 'other') }}", contexts, status)).toBe(false);
  });

  it("reports a malformed expression instead of failing silently", () => {
    expect(() => evaluateCondition("${{ needs. }}", { needs: {} }, status)).toThrow(RelayExpressionError);
    // An unknown context is a authoring mistake worth surfacing.
    expect(() => evaluateCondition("${{ nosuch.thing }}", {}, status)).toThrow(RelayExpressionError);
  });
});

describe("workflow configuration", () => {
  const base = {
    version: 2,
    sources: { queue: { use: "command", with: { discover: { command: "/bin/echo" } } } },
  };

  it("accepts `uses` as an alias for `use` and keeps plugin config untouched", () => {
    const config = normalizeRelayConfig({
      ...base,
      sources: { queue: { uses: "command", with: { discover: { command: "/bin/echo" }, uses: "left alone" } } },
      workflows: { feature: { on: { source: "queue" }, jobs: { one: { uses: "command", with: { command: "/bin/echo" } } } } },
    });
    expect(config.sources.queue.use).toBe("command");
    expect((config.sources.queue.with as Record<string, unknown>).uses).toBe("left alone");
    expect(config.workflows.feature.jobs!.one.use).toBe("command");
  });

  it("rejects a dependency cycle, a self-dependency, and an unknown job", () => {
    const workflow = (jobs: Record<string, unknown>) => () => normalizeRelayConfig({ ...base, workflows: { feature: { on: { source: "queue" }, jobs } } });
    expect(workflow({
      a: { use: "command", with: { command: "/bin/echo" }, needs: "b" },
      b: { use: "command", with: { command: "/bin/echo" }, needs: "a" },
    })).toThrow(/cycle/);
    expect(workflow({ a: { use: "command", with: { command: "/bin/echo" }, needs: "a" } })).toThrow(/cannot need itself/);
    expect(workflow({ a: { use: "command", with: { command: "/bin/echo" }, needs: "ghost" } })).toThrow(/unknown job 'ghost'/);
  });

  it("rejects a workflow whose name a trigger already uses", () => {
    expect(() => normalizeRelayConfig({
      ...base,
      actions: { notify: { use: "command", with: { command: "/bin/echo" } } },
      triggers: [{ id: "feature", source: "queue", actions: ["notify"] }],
      workflows: { feature: { on: { source: "queue" }, jobs: { one: { use: "notify" } } } },
    })).toThrow(/already used by a trigger/);
  });

  it("keeps a status suffix on a string need", () => {
    const config = normalizeRelayConfig({
      ...base,
      workflows: {
        feature: {
          on: { source: "queue" },
          jobs: {
            implement: { use: "command", with: { command: "/bin/echo" } },
            dev: { use: "command", with: { command: "/bin/echo" }, needs: "implement.Started" },
          },
        },
      },
    });
    expect(config.workflows.feature.jobs!.dev.needs).toBe("implement.Started");
  });

  it("resolves a status suffix after a dotted job id and validates it", () => {
    const config = normalizeRelayConfig({
      ...base,
      workflows: {
        feature: {
          on: { source: "queue" },
          jobs: {
            "tmux.create-window-1": { use: "command", with: { command: "/bin/echo" } },
            cleanup: { use: "command", with: { command: "/bin/echo" }, needs: "tmux.create-window-1.succeeded" },
          },
        },
      },
    });
    const compiled = domainWorkflow(config, "feature", config.workflows.feature, { id: "repo", root: "/repo" });
    expect(compiled.jobs.find((job) => job.id === "cleanup")!.needs).toEqual([{ job: "tmux.create-window-1", status: "succeeded" }]);

    expect(() => normalizeRelayConfig({
      ...base,
      workflows: {
        feature: {
          on: { source: "queue" },
          jobs: {
            "tmux.create-window-1": { use: "command", with: { command: "/bin/echo" } },
            cleanup: { use: "command", with: { command: "/bin/echo" }, needs: "tmux.create-window-1.finished" },
          },
        },
      },
    })).toThrow(/Unknown job status 'finished'/);

    expect(() => normalizeRelayConfig({
      ...base,
      workflows: {
        feature: {
          on: { source: "queue" },
          jobs: {
            "tmux.create-window-1": { use: "command", with: { command: "/bin/echo" } },
            cleanup: { use: "command", with: { command: "/bin/echo" }, needs: "missing.started" },
          },
        },
      },
    })).toThrow(/unknown job 'missing'/);

    expect(() => normalizeRelayConfig({
      ...base,
      workflows: {
        feature: {
          on: { source: "queue" },
          jobs: {
            "tmux.create-window-1": { use: "command", with: { command: "/bin/echo" }, needs: "cleanup" },
            cleanup: { use: "command", with: { command: "/bin/echo" }, needs: "tmux.create-window-1.succeeded" },
          },
        },
      },
    })).toThrow(/cycle/);
  });

  it("prefers an exact dotted job id over a matching status suffix", () => {
    const config = normalizeRelayConfig({
      ...base,
      workflows: {
        feature: {
          on: { source: "queue" },
          jobs: {
            "tmux.create-window-1": { use: "command", with: { command: "/bin/echo" } },
            "tmux.create-window-1.succeeded": { use: "command", with: { command: "/bin/echo" } },
            cleanup: { use: "command", with: { command: "/bin/echo" }, needs: "tmux.create-window-1.succeeded" },
          },
        },
      },
    });
    const compiled = domainWorkflow(config, "feature", config.workflows.feature, { id: "repo", root: "/repo" });
    expect(compiled.jobs.find((job) => job.id === "cleanup")!.needs).toEqual([{ job: "tmux.create-window-1.succeeded" }]);
  });
});

describe("matrix jobs", () => {
  it("expands one declaration into an instance per combination, sharing a group", () => {
    const config = normalizeRelayConfig({
      version: 2,
      sources: { queue: { use: "command", with: { discover: { command: "/bin/echo" } } } },
      harnesses: { codex: { use: "codex" }, claude: { use: "claude" } },
      workflows: {
        race: {
          on: { source: "queue" },
          jobs: {
            implement: {
              use: "launch",
              strategy: { matrix: { harness: ["codex", "claude"] } },
              with: { harness: "${{ matrix.harness }}", mode: "oneshot", prompt: "go" },
            },
            review: { use: "command", with: { command: "/bin/echo" }, needs: "implement" },
          },
        },
      },
      execution: { adapter: "tmux" },
    });
    const workflow = domainWorkflow(config, "race", config.workflows.race, { id: "r", root: "/repo" });

    const implement = workflow.jobs.filter((job) => job.group === "implement");
    expect(implement.map((job) => job.id)).toEqual(["implement (harness=codex)", "implement (harness=claude)"]);
    // The matrix value is bound into the job's own configuration.
    expect((implement[0].config as Record<string, unknown>).harness).toBe("codex");
    expect((implement[1].config as Record<string, unknown>).harness).toBe("claude");
    expect(implement[0].matrix).toEqual({ harness: "codex" });

    // `needs: implement` addresses the group, so the reviewer waits for both.
    const instances = jobInstances(workflow.jobs);
    expect(instances.get("implement")).toHaveLength(2);
    const review = workflow.jobs.find((job) => job.id === "review")!;
    const decide = (states: Record<string, WorkflowJobState>) =>
      decideJob({ job: review, states, item, known: new Set(instances.keys()), instances });

    expect(decide({ "implement (harness=codex)": state("succeeded") })).toMatchObject({ action: "hold" });
    expect(decide({
      "implement (harness=codex)": state("succeeded"),
      "implement (harness=claude)": state("succeeded"),
    })).toEqual({ action: "run" });
    // One failed instance makes the whole group unsatisfiable.
    expect(decide({
      "implement (harness=codex)": state("succeeded"),
      "implement (harness=claude)": state("failed"),
    })).toMatchObject({ action: "settle", status: "omitted" });
  });

  it("fails a job that outlives its own timeout without touching the rest", () => {
    const job: WorkflowJobDefinition = { id: "implement", use: "launch", timeoutMs: 60_000 };
    const started = (at: string): WorkflowJobState => ({ status: "started", attempts: 1, startedAt: at });
    expect(jobTimedOut(job, started("2026-08-19T10:00:00.000Z"), new Date("2026-08-19T10:00:30.000Z"))).toBe(false);
    expect(jobTimedOut(job, started("2026-08-19T10:00:00.000Z"), new Date("2026-08-19T10:01:30.000Z"))).toBe(true);
    // A job without its own deadline relies on the run's.
    expect(jobTimedOut({ id: "x", use: "launch" }, started("2026-08-19T09:00:00.000Z"), new Date("2026-08-19T12:00:00.000Z"))).toBe(false);
    // A settled job is never re-failed.
    expect(jobTimedOut(job, { status: "succeeded", attempts: 1, startedAt: "2026-08-19T10:00:00.000Z" }, new Date("2026-08-19T23:00:00.000Z"))).toBe(false);
  });
});

describe("reusable workflow files", () => {
  async function withFile(contents: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "task-relay-reusable-"));
    await writeFile(join(root, "review.yaml"), contents);
    return root;
  }

  const reviewFile = [
    "inputs:",
    "  harness: { required: true }",
    "  model: { default: claude-opus-5 }",
    "  focus: { default: correctness }",
    "jobs:",
    "  review:",
    "    uses: launch",
    "    with:",
    "      harness: ${{ inputs.harness }}",
    "      model: ${{ inputs.model }}",
    "      mode: oneshot",
    "      prompt: \"Review {{item.id}} for ${{ inputs.focus }}.\"",
  ].join("\n");

  it("binds inputs into the jobs and leaves later-stage expressions alone", async () => {
    const root = await withFile([reviewFile, "    if: ${{ always() }}", "    needs: []"].join("\n"));
    const loaded = await loadReusableWorkflow({
      specifier: "./review.yaml", projectRoot: root, with: { harness: "claude", focus: "missing tests" }, subject: "Workflow 'x'",
    });
    const job = loaded.jobs.review;
    const config = job.with as Record<string, string>;
    expect(config.harness).toBe("claude");
    expect(config.model).toBe("claude-opus-5");
    expect(config.prompt).toBe("Review {{item.id}} for missing tests.");
    // Handlebars and later-stage expressions survive this pass untouched.
    expect(job.if).toBe("${{ always() }}");
  });

  it("rejects a missing required input and an input the file never declared", async () => {
    const root = await withFile(reviewFile);
    await expect(loadReusableWorkflow({ specifier: "./review.yaml", projectRoot: root, subject: "Workflow 'x'" }))
      .rejects.toThrow(/requires input 'harness'/);
    await expect(loadReusableWorkflow({ specifier: "./review.yaml", projectRoot: root, with: { harness: "claude", nope: "1" }, subject: "Workflow 'x'" }))
      .rejects.toThrow(/declares no input named 'nope'/);
  });

  it("explains how to get a package-qualified workflow that is not installed", async () => {
    const root = await withFile(reviewFile);
    await expect(loadReusableWorkflow({ specifier: "@company/relay-workflows/review.yaml", projectRoot: root, subject: "Workflow 'x'" }))
      .rejects.toThrow(/relay plugin install @company\/relay-workflows/);
    await expect(loadReusableWorkflow({ specifier: "not-a-path", projectRoot: root, subject: "Workflow 'x'" }))
      .rejects.toThrow(/is not a workflow file/);
  });

  it("resolves a workflow shipped inside an installed package", async () => {
    const root = await withFile(reviewFile);
    const loaded = await loadReusableWorkflow({
      specifier: "@company/relay-workflows/review.yaml",
      projectRoot: "/nowhere",
      with: { harness: "codex" },
      lookup: (name) => name === "@company/relay-workflows" ? root : undefined,
      subject: "Workflow 'x'",
    });
    expect((loaded.jobs.review.with as Record<string, string>).harness).toBe("codex");
  });

  it("refuses a workflow that both uses a file and declares jobs", () => {
    const base = {
      version: 2,
      sources: { queue: { use: "command", with: { discover: { command: "/bin/echo" } } } },
    };
    expect(() => normalizeRelayConfig({
      ...base,
      workflows: { x: { on: { source: "queue" }, uses: "./review.yaml", jobs: { a: { use: "command" } } } },
    })).toThrow(/cannot also declare jobs/);
    expect(() => normalizeRelayConfig({
      ...base,
      workflows: { x: { on: { source: "queue" } } },
    })).toThrow(/declare 'jobs', or 'uses' a reusable workflow file/);
  });
});

describe("configuration schema", () => {
  it("describes workflows, jobs, and needs so an editor can complete them", async () => {
    const { relayJsonSchema, schemaDirective } = await import("../src/config/json-schema.js");
    const schema = relayJsonSchema() as Record<string, never>;
    const properties = schema.properties as Record<string, never>;
    expect(Object.keys(properties)).toContain("workflows");

    const workflow = (properties.workflows as Record<string, never>).additionalProperties as Record<string, never>;
    expect(Object.keys(workflow.properties as Record<string, never>)).toEqual(
      expect.arrayContaining(["enabled", "on", "maxConcurrent", "targets", "timeoutMinutes", "jobs"]),
    );

    const job = ((workflow.properties as Record<string, never>).jobs as Record<string, never>).additionalProperties as Record<string, never>;
    expect(Object.keys(job.properties as Record<string, never>)).toEqual(
      expect.arrayContaining(["use", "with", "needs", "if", "continueOnError"]),
    );

    expect(schemaDirective("./.task-relay.schema.json")).toBe("# yaml-language-server: $schema=./.task-relay.schema.json");
  });
});

describe("workflow runs end to end", () => {
  function run(root: string, ...argv: string[]): Promise<{ output: string; errors: string }> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output: string[] = [];
    const errors: string[] = [];
    stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
    const program = createRelayProgram({
      handlers: createRuntimeHandlers(),
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      cwd: () => root,
    });
    return program.parseAsync(["node", "relay", ...argv]).then(() => ({ output: output.join(""), errors: errors.join("") }));
  }

  async function project(jobs: Record<string, unknown>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "task-relay-workflow-"));
    process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "task-relay-workflow-state-"));
    const discover = "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'ENG-1',title:'Add a dev server'}]}))";
    await writeFile(join(root, ".task-relay.yaml"), stringify({
      version: 2,
      project: { name: "workflow-test" },
      sources: { queue: { use: "command", with: { discover: { command: process.execPath, args: ["-e", discover] } } } },
      workflows: { feature: { on: { source: "queue" }, jobs } },
      logging: { level: "silent", pretty: false },
    }));
    return root;
  }

  const echo = (text: string) => ({ use: "command", with: { command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(text)})`] } });
  const fail = { use: "command", with: { command: process.execPath, args: ["-e", "process.exit(3)"] } };

  it("passes a job's output to a later job's condition and records every job state", async () => {
    const root = await project({
      one: echo("yes"),
      two: { ...echo("second"), needs: "one", if: "${{ needs.one.outputs.stdout == 'yes' }}" },
      three: { ...echo("third"), needs: "one", if: "${{ needs.one.outputs.stdout == 'no' }}" },
    });

    const preview = await run(root, "workflow", "test", "feature");
    expect(preview.errors).toBe("");
    expect(preview.output).toContain("Workflow: feature");
    expect(preview.output).toContain("[no run yet]");
    expect(preview.output).toContain("would start now");

    const tick = await run(root, "once", "--trigger", "feature");
    expect(tick.errors).toBe("");
    expect(tick.output).toContain("0 action failures");

    const projectRoot = (await loadRelayConfig(root)).projectRoot;
    const runs = await new RepositoryStateStore(projectRoot).listWorkflowRuns({ id: "workflow-test", root: projectRoot });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].jobs.one).toMatchObject({ status: "succeeded", outputs: { stdout: "yes", exitCode: 0 } });
    expect(runs[0].jobs.two).toMatchObject({ status: "succeeded", outputs: { stdout: "second" } });
    // Its condition was false, so it settles as skipped rather than retrying.
    expect(runs[0].jobs.three).toMatchObject({ status: "skipped" });

    // A completed run is not restarted by the next poll, and the tick says why.
    const again = await run(root, "once", "--trigger", "feature");
    expect(again.output).toContain("Workflow run item already succeeded.");
    expect(again.output).toContain("0 actions");
  });

  it("settles a cleanup workflow when its terminal item has no worker", async () => {
    const root = await project({ cleanup: { use: "cleanup" } });
    const projectRoot = (await loadRelayConfig(root)).projectRoot;
    const repository = { id: "workflow-test", root: projectRoot };
    const store = new RepositoryStateStore(projectRoot);

    const tick = await run(root, "once", "--trigger", "feature");
    expect(tick.errors).toBe("");
    expect(tick.output).toContain("0 action failures");

    const [workflowRun] = await store.listWorkflowRuns(repository);
    expect(workflowRun.status).toBe("succeeded");
    expect(workflowRun.jobs.cleanup).toMatchObject({ status: "skipped", message: "No matching workers." });

    const again = await run(root, "once", "--trigger", "feature");
    expect(again.output).toContain("Workflow run item already succeeded.");
  });

  it("advances a started job to succeeded when its agent signals, then releases the dependent job", async () => {
    const root = await project({
      one: echo("unused"),
      two: { ...echo("reviewing"), needs: "one", if: "${{ needs.one.outputs.reviewed == 'yes' }}" },
    });
    const projectRoot = (await loadRelayConfig(root)).projectRoot;
    const repository = { id: "workflow-test", root: projectRoot };
    const store = new RepositoryStateStore(projectRoot);

    // Stand in for a launch: a live worker whose workflow job is `started`.
    const identity = { repository, sourceId: "queue", itemId: "ENG-1", triggerId: "feature:one" };
    const claimed = await store.claim({
      id: "unused", identity, item, agent: { agentId: "codex" }, claimedAt: "2026-08-19T09:00:00.000Z", maxConcurrent: 1,
      trigger: { id: "feature:one", sourceId: "queue", repository, enabled: true },
    });
    claimed!.status = "running";
    claimed!.worker = { id: "ENG-1:codex", startedAt: "2026-08-19T09:00:00.000Z", metadata: { workspace: projectRoot } };
    await store.update(claimed!);
    const workflowIdentity = { repository, workflowId: "feature", sourceId: "queue", itemId: "ENG-1", occurrence: "item" };
    await store.openWorkflowRun({ identity: workflowIdentity, item, startedAt: "2026-08-19T09:00:00.000Z" });
    await store.updateWorkflowJob(workflowIdentity, "one", { status: "started", runId: claimed!.id, workerId: "ENG-1:codex", at: "2026-08-19T09:00:00.000Z" });

    // While the agent runs, the dependent job waits rather than starting.
    const waiting = await run(root, "once", "--trigger", "feature");
    expect(waiting.errors).toBe("");
    expect((await store.listWorkflowRuns(repository))[0].jobs.two?.status ?? "pending").toBe("pending");

    const signalled = await run(root, "signal", "ENG-1:codex", "done", "--output", "reviewed=yes");
    expect(signalled.errors).toBe("");
    expect(signalled.output).toContain("recorded succeeded");

    const released = await run(root, "once", "--trigger", "feature");
    expect(released.errors).toBe("");
    const [workflowRun] = await store.listWorkflowRuns(repository);
    expect(workflowRun.jobs.one).toMatchObject({ status: "succeeded", outputs: { reviewed: "yes" } });
    expect(workflowRun.jobs.two).toMatchObject({ status: "succeeded", outputs: { stdout: "reviewing" } });
    expect(workflowRun.status).toBe("succeeded");
  });

  it("holds a concurrency group, then cancels the older run when told to", async () => {
    async function grouped(cancelInProgress: boolean) {
      const root = await mkdtemp(join(tmpdir(), "task-relay-group-"));
      process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "task-relay-group-state-"));
      const discover = "process.stdout.write(JSON.stringify({items:[{sourceId:'queue',id:'ENG-1',title:'Add a dev server'}]}))";
      await writeFile(join(root, ".task-relay.yaml"), stringify({
        version: 2,
        project: { name: "group-test" },
        sources: { queue: { use: "command", with: { discover: { command: process.execPath, args: ["-e", discover] } } } },
        workflows: {
          feature: {
            // One group for the whole workflow, so any live run holds it.
            concurrency: { group: "feature", cancelInProgress },
            on: { source: "queue" },
            jobs: { one: { use: "command", with: { command: process.execPath, args: ["-e", "0"] } } },
          },
        },
        logging: { level: "silent", pretty: false },
      }));
      const projectRoot = (await loadRelayConfig(root)).projectRoot;
      const repository = { id: "group-test", root: projectRoot };
      const store = new RepositoryStateStore(projectRoot);
      // An older run for a different item is already live and holding the group.
      const identity = { repository, workflowId: "feature", sourceId: "queue", itemId: "ENG-9", occurrence: "item" };
      await store.openWorkflowRun({
        identity,
        item: { sourceId: "queue", id: "ENG-9", title: "older" },
        startedAt: "2026-08-19T09:00:00.000Z",
        concurrencyGroup: "feature",
      });
      await store.updateWorkflowJob(identity, "one", { status: "started", at: "2026-08-19T09:00:01.000Z" });
      return { root, store, repository };
    }

    const held = await grouped(false);
    const heldTick = await run(held.root, "once", "--trigger", "feature");
    expect(heldTick.errors).toBe("");
    expect(heldTick.output).toContain("Concurrency group 'feature' is held by ENG-9");
    // The newer item yielded, so no second run was opened.
    expect(await held.store.listWorkflowRuns(held.repository)).toHaveLength(1);

    const cancelling = await grouped(true);
    const cancelTick = await run(cancelling.root, "once", "--trigger", "feature");
    expect(cancelTick.errors).toBe("");
    expect(cancelTick.output).toContain("superseded in concurrency group");
    const runs = await cancelling.store.listWorkflowRuns(cancelling.repository);
    expect(runs).toHaveLength(2);
    const older = runs.find((entry) => entry.identity.itemId === "ENG-9")!;
    expect(older.status).toBe("failed");
    expect(older.jobs.one).toMatchObject({ status: "omitted", message: "Superseded by a newer run in the same concurrency group." });
    expect(runs.find((entry) => entry.identity.itemId === "ENG-1")!.status).toBe("succeeded");
  });

  it("reopens a finished run so a retried job can advance again", async () => {
    const root = await project({ one: fail, two: { ...echo("after"), needs: "one" } });
    const projectRoot = (await loadRelayConfig(root)).projectRoot;
    const store = new RepositoryStateStore(projectRoot);
    const repository = { id: "workflow-test", root: projectRoot };

    await run(root, "once", "--trigger", "feature");
    let [workflowRun] = await store.listWorkflowRuns(repository);
    expect(workflowRun.status).toBe("failed");
    expect(workflowRun.jobs.one.status).toBe("failed");
    expect(workflowRun.jobs.two.status).toBe("omitted");

    const retried = await run(root, "workflow", "retry", "feature", "ENG-1");
    expect(retried.errors).toBe("");
    expect(retried.output).toContain("Retrying feature for ENG-1");
    [workflowRun] = await store.listWorkflowRuns(repository);
    expect(workflowRun.status).toBe("running");
    expect(workflowRun.jobs.one.status).toBe("pending");

    // The job still fails, but the retry genuinely re-ran it.
    await run(root, "once", "--trigger", "feature");
    [workflowRun] = await store.listWorkflowRuns(repository);
    expect(workflowRun.jobs.one.attempts).toBe(2);
    expect(workflowRun.status).toBe("failed");
  });

  it("omits a job after its dependency fails, and always() still runs", async () => {
    const root = await project({
      one: fail,
      two: { ...echo("never"), needs: "one" },
      three: { ...echo("cleanup"), needs: "one", if: "${{ always() }}" },
    });

    const tick = await run(root, "once", "--trigger", "feature");
    expect(tick.errors).toBe("");
    expect(tick.output).toContain("1 action failures");

    const projectRoot = (await loadRelayConfig(root)).projectRoot;
    const runs = await new RepositoryStateStore(projectRoot).listWorkflowRuns({ id: "workflow-test", root: projectRoot });
    expect(runs[0].jobs.one.status).toBe("failed");
    expect(runs[0].jobs.two).toMatchObject({ status: "omitted", message: "one.Succeeded can no longer be satisfied" });
    expect(runs[0].jobs.three.status).toBe("succeeded");
    expect(runs[0].status).toBe("failed");

    const listed = await run(root, "workflow", "runs");
    expect(listed.output).toContain("feature  ENG-1  failed");
    expect(listed.output).toContain("omitted");
  });
});
