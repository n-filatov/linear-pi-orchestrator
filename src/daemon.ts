import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { stateDirectory } from "./logging/events.js";

type DaemonRecord = { pid: number; projectRoot: string; startedAt: string };

export class RepositoryDaemon {
  private readonly recordPath: string;
  readonly logPath: string;

  constructor(private readonly projectRoot: string) {
    const directory = stateDirectory(projectRoot);
    this.recordPath = path.join(directory, "daemon.json");
    this.logPath = path.join(directory, "daemon.log");
  }

  async start(): Promise<string> {
    const current = await this.statusRecord();
    if (current?.running) return `Task Relay daemon is already running (pid ${current.record.pid}).`;
    fs.mkdirSync(path.dirname(this.recordPath), { recursive: true });
    const output = fs.openSync(this.logPath, "a");
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/relay.js");
    const child = spawn(process.execPath, [bin, "watch"], {
      cwd: this.projectRoot,
      detached: true,
      stdio: ["ignore", output, output],
      env: process.env,
    });
    child.unref();
    const record: DaemonRecord = { pid: child.pid!, projectRoot: this.projectRoot, startedAt: new Date().toISOString() };
    fs.writeFileSync(this.recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return `Started Task Relay daemon (pid ${record.pid}). Logs: ${this.logPath}`;
  }

  async stop(): Promise<string> {
    const status = await this.statusRecord();
    if (!status?.running) {
      fs.rmSync(this.recordPath, { force: true });
      return "Task Relay daemon is not running.";
    }
    if (!status.command.includes("relay") || !status.command.includes("watch")) {
      throw new Error(`Refusing to stop pid ${status.record.pid}: it no longer looks like a Task Relay watcher.`);
    }
    process.kill(status.record.pid, "SIGTERM");
    fs.rmSync(this.recordPath, { force: true });
    return `Stopped Task Relay daemon (pid ${status.record.pid}).`;
  }

  async status(): Promise<string> {
    const status = await this.statusRecord();
    if (!status) return `Task Relay daemon is not running. Logs: ${this.logPath}`;
    if (!status.running) return `Task Relay daemon pid ${status.record.pid} is stale. Logs: ${this.logPath}`;
    return `Task Relay daemon is running (pid ${status.record.pid}, since ${status.record.startedAt}). Logs: ${this.logPath}`;
  }

  private async statusRecord(): Promise<{ record: DaemonRecord; running: boolean; command: string } | undefined> {
    let record: DaemonRecord;
    try { record = JSON.parse(fs.readFileSync(this.recordPath, "utf8")) as DaemonRecord; }
    catch { return undefined; }
    if (!Number.isInteger(record.pid) || record.pid < 1 || path.resolve(record.projectRoot) !== path.resolve(this.projectRoot)) return undefined;
    const inspected = await execa("ps", ["-p", String(record.pid), "-o", "command="], { reject: false });
    const command = inspected.stdout?.trim() ?? "";
    return { record, running: inspected.exitCode === 0 && command.length > 0, command };
  }
}
