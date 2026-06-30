import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUILD_DATE, RELEASE_TAG } from "./version.js";

const REPO = "n-filatov/linear-pi-orchestrator";
const CACHE_PATH = path.join(os.homedir(), ".pi", "linear-pi", "update-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  checkedAt: string;
  latestPublishedAt: string | null;
  updateAvailable: boolean;
}

function readCache(): UpdateCache | null {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as UpdateCache;
    if (Date.now() - new Date(data.checkedAt).getTime() < CACHE_TTL_MS) return data;
  } catch {}
  return null;
}

function writeCache(cache: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {}
}

async function fetchLatestRelease(): Promise<{ published_at: string } | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/tags/latest`,
      { headers: { "User-Agent": "linear-pi-cli" }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    return (await res.json()) as { published_at: string };
  } catch {
    return null;
  }
}

/** Returns true if a cached update notification should be shown. */
export function readCachedUpdateAvailable(): boolean {
  return readCache()?.updateAvailable ?? false;
}

/**
 * Fires in the background (no await) — fetches latest release once per 24h
 * and updates the on-disk cache so the next run can show the update notice.
 */
export async function checkForUpdateBackground(): Promise<void> {
  if (BUILD_DATE === "dev") return; // Skip in dev/local runs
  if (readCache()) return; // Cache is still fresh
  const release = await fetchLatestRelease();
  if (!release) return;
  writeCache({
    checkedAt: new Date().toISOString(),
    latestPublishedAt: release.published_at,
    updateAvailable: new Date(release.published_at) > new Date(BUILD_DATE),
  });
}

function detectPlatform(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin" && a === "arm64") return "macos-arm64";
  if (p === "darwin") return "macos-x64";
  if (p === "linux") return "linux-x64";
  throw new Error(`Unsupported platform: ${p}/${a}. Download manually from https://github.com/${REPO}/releases`);
}

/** Download and replace the running binary with the latest release. */
export async function performUpdate(): Promise<void> {
  const platform = detectPlatform();
  const asset = `linear-pi-${platform}`;
  const url = `https://github.com/${REPO}/releases/latest/download/${asset}`;

  process.stdout.write(`Downloading ${asset} from latest release...\n`);

  const res = await fetch(url, {
    headers: { "User-Agent": "linear-pi-cli" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}\n${url}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const currentBin = process.execPath;
  const tmpBin = `${currentBin}.update`;

  fs.writeFileSync(tmpBin, buffer, { mode: 0o755 });
  fs.renameSync(tmpBin, currentBin);

  try { fs.rmSync(CACHE_PATH); } catch {}

  process.stdout.write(`Updated successfully. Run: linear-pi --version\n`);
}

/** Human-readable version string from embedded build metadata. */
export function versionString(): string {
  if (BUILD_DATE === "dev") return "dev";
  if (RELEASE_TAG !== "latest" && RELEASE_TAG !== "dev") return `${RELEASE_TAG} (${BUILD_DATE})`;
  return `latest (${BUILD_DATE})`;
}
