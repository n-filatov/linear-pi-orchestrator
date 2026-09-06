import { access } from "node:fs/promises";

const packages = [
  "@task-relay/domain",
  "@task-relay/plugin-sdk",
  "@task-relay/plugin-host",
  "@task-relay/config",
  "@task-relay/trigger-command",
  "@task-relay/action-launch",
  "@task-relay/action-cleanup",
  "@task-relay/action-command",
  "@task-relay/action-worker-exec",
  "@task-relay/action-worker-send",
  "@task-relay/action-tmux-create-window",
  "@task-relay/action-codex-start-session",
  "@task-relay/action-codex-send-prompt",
  "@task-relay/integration-linear",
  "@task-relay/trigger-linear-issue-change",
  "@task-relay/storage-sqlite",
  "@task-relay/global-registry",
  "@task-relay/plugin-testing",
  "@task-relay/application",
];

for (const packageName of packages) {
  const entry = await import(packageName);
  if (Object.keys(entry).length === 0) throw new Error(`${packageName} exported no built JavaScript.`);
  const directory = packageName.replace("@task-relay/", "");
  await access(new URL(`../packages/${directory}/dist/index.d.ts`, import.meta.url));
}
console.log(JSON.stringify({ imported: packages.length, declarations: true, resolution: "default Node package exports" }));
