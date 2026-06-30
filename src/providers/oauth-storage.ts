import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const OAUTH_DIR = path.join(os.homedir(), ".pi", "linear-pi", "oauth");

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface StoredClientInfo {
  clientId: string;
  clientSecret?: string;
  redirectUris?: string[];
}

export interface AuthEntry {
  tokens?: StoredTokens;
  clientInfo?: StoredClientInfo;
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string;
}

function entryPath(serverName: string): string {
  const hash = createHash("sha256").update(serverName, "utf8").digest("hex");
  return path.join(OAUTH_DIR, `${hash}.json`);
}

function readEntry(serverName: string): AuthEntry {
  try {
    const filePath = entryPath(serverName);
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as AuthEntry;
  } catch {
    return {};
  }
}

function writeEntry(serverName: string, entry: AuthEntry) {
  fs.mkdirSync(OAUTH_DIR, { recursive: true });
  fs.writeFileSync(entryPath(serverName), JSON.stringify(entry, null, 2), { mode: 0o600 });
}

export function getTokens(serverName: string): StoredTokens | undefined {
  return readEntry(serverName).tokens;
}

export function saveTokens(serverName: string, tokens: StoredTokens) {
  const entry = readEntry(serverName);
  writeEntry(serverName, { ...entry, tokens });
}

export function clearTokens(serverName: string) {
  const entry = readEntry(serverName);
  const { tokens: _, ...rest } = entry;
  writeEntry(serverName, rest);
}

export function getClientInfo(serverName: string): StoredClientInfo | undefined {
  return readEntry(serverName).clientInfo;
}

export function saveClientInfo(serverName: string, info: StoredClientInfo) {
  const entry = readEntry(serverName);
  writeEntry(serverName, { ...entry, clientInfo: info });
}

export function clearClientInfo(serverName: string) {
  const entry = readEntry(serverName);
  const { clientInfo: _, ...rest } = entry;
  writeEntry(serverName, rest);
}

export function getCodeVerifier(serverName: string): string | undefined {
  return readEntry(serverName).codeVerifier;
}

export function saveCodeVerifier(serverName: string, verifier: string) {
  const entry = readEntry(serverName);
  writeEntry(serverName, { ...entry, codeVerifier: verifier });
}

export function getOAuthState(serverName: string): string | undefined {
  return readEntry(serverName).oauthState;
}

export function saveOAuthState(serverName: string, state: string) {
  const entry = readEntry(serverName);
  writeEntry(serverName, { ...entry, oauthState: state });
}

export function clearAll(serverName: string) {
  try { fs.rmSync(entryPath(serverName), { force: true }); } catch {}
}
