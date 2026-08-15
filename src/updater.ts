import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { execa } from "execa";

const DEFAULT_REPOSITORY = "n-filatov/linear-pi-orchestrator";

export type RelayUpdateOptions = {
  version?: string;
  executablePath?: string;
  releaseBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  smokeTest?: (executable: string) => Promise<void>;
  platform?: NodeJS.Platform;
  architecture?: string;
};

export type RelayUpdateCheck = {
  version: string;
  asset: string;
  executablePath: string;
  currentChecksum: string;
  expectedChecksum: string;
  updateAvailable: boolean;
};

export function installedRelayExecutable(): string {
  const configured = process.env.RELAY_EXECUTABLE_PATH;
  if (configured) return configured;
  const executable = process.execPath;
  if (!["relay", "task-relay"].includes(basename(executable))) {
    throw new Error("Self-update is only available from an installed relay binary. Reinstall with install.sh when running from source.");
  }
  return executable;
}

export async function checkRelayUpdate(options: RelayUpdateOptions = {}): Promise<RelayUpdateCheck> {
  const version = validVersion(options.version ?? "latest");
  const asset = releaseAsset(options.platform ?? process.platform, options.architecture ?? process.arch);
  const executablePath = options.executablePath ?? installedRelayExecutable();
  const base = options.releaseBaseUrl ?? `https://github.com/${DEFAULT_REPOSITORY}/releases/download/${version}`;
  const fetcher = options.fetch ?? globalThis.fetch;
  const checksums = await downloadText(fetcher, `${base}/checksums.txt`);
  const expectedChecksum = checksumFor(checksums, asset);
  const currentChecksum = await sha256(executablePath);
  return { version, asset, executablePath, currentChecksum, expectedChecksum, updateAvailable: currentChecksum !== expectedChecksum };
}

export async function updateRelay(options: RelayUpdateOptions = {}): Promise<RelayUpdateCheck> {
  const check = await checkRelayUpdate(options);
  if (!check.updateAvailable) return check;

  const base = options.releaseBaseUrl ?? `https://github.com/${DEFAULT_REPOSITORY}/releases/download/${check.version}`;
  const fetcher = options.fetch ?? globalThis.fetch;
  const directory = dirname(check.executablePath);
  const temporaryDirectory = await mkdtemp(join(directory, ".task-relay-update-"));
  const candidate = join(temporaryDirectory, "relay");
  try {
    await downloadFile(fetcher, `${base}/${check.asset}`, candidate);
    const candidateChecksum = await sha256(candidate);
    if (candidateChecksum !== check.expectedChecksum) {
      throw new Error(`Checksum verification failed for ${check.asset}.`);
    }
    await chmod(candidate, 0o755);
    await (options.smokeTest ?? smokeTest)(candidate);
    await rename(candidate, check.executablePath);
    return { ...check, currentChecksum: candidateChecksum, updateAvailable: false };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function downloadText(fetcher: typeof globalThis.fetch, url: string): Promise<string> {
  const response = await fetcher(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}.`);
  return response.text();
}

async function downloadFile(fetcher: typeof globalThis.fetch, url: string, destination: string): Promise<void> {
  const response = await fetcher(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}.`);
  if (!response.body) throw new Error(`Could not download ${url}: response had no body.`);
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(destination, { mode: 0o600 }));
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function checksumFor(document: string, asset: string): string {
  for (const line of document.split("\n")) {
    const [checksum, name] = line.trim().split(/\s+/, 2);
    if (name?.replace(/^\*/, "") === asset && /^[a-fA-F0-9]{64}$/.test(checksum ?? "")) return checksum.toLowerCase();
  }
  throw new Error(`checksums.txt does not contain ${asset}.`);
}

function releaseAsset(platform: NodeJS.Platform, architecture: string): string {
  if (platform === "darwin" && ["arm64", "aarch64"].includes(architecture)) return "task-relay-macos-arm64";
  if (platform === "darwin" && ["x64", "x86_64", "amd64"].includes(architecture)) return "task-relay-macos-x64";
  if (platform === "linux" && ["x64", "x86_64", "amd64"].includes(architecture)) return "task-relay-linux-x64";
  throw new Error(`No Task Relay release is published for ${platform}/${architecture}.`);
}

function validVersion(version: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) throw new Error(`Invalid release version '${version}'.`);
  return version;
}

async function smokeTest(executable: string): Promise<void> {
  const result = await execa(executable, ["--version"], { reject: false });
  if (result.exitCode !== 0) throw new Error(`Downloaded Relay binary failed its smoke test: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
}
