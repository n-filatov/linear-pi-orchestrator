import * as http from "node:http";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, auth as runSdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformationMixed,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { LinearClient } from "./linear.js";
import type { LinearIssue, ListIssuesArgs, SaveIssueArgs, ExtractedImage } from "../types.js";
import {
  getTokens, saveTokens, clearTokens,
  getClientInfo, saveClientInfo, clearClientInfo,
  getCodeVerifier, saveCodeVerifier,
  getOAuthState, saveOAuthState, clearAll,
  type StoredTokens,
} from "./oauth-storage.js";

const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";
const OAUTH_CALLBACK_PORT = 19876;
const OAUTH_CALLBACK_PATH = "/callback";
const SERVER_NAME = "linear-sdk";

// ── OAuth provider ────────────────────────────────────────────────────────────

class LinearOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
  _callbackPromise: Promise<{ code: string; state: string }> | undefined;
  readonly interactive: boolean;
  /** Set true when redirectToAuthorization actually runs the interactive flow (vs. tokens already valid). */
  didRedirect = false;

  constructor({ interactive = true }: { interactive?: boolean } = {}) {
    this.interactive = interactive;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Linear Pi CLI",
      client_uri: "https://github.com/n-filatov/linear-pi-orchestrator",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const info = getClientInfo(SERVER_NAME);
    if (!info) return undefined;
    return { client_id: info.clientId, client_secret: info.clientSecret };
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    saveClientInfo(SERVER_NAME, {
      clientId: info.client_id,
      clientSecret: info.client_secret,
      redirectUris: info.redirect_uris,
    });
  }

  tokens(): OAuthTokens | undefined {
    const stored = getTokens(SERVER_NAME);
    if (!stored) return undefined;
    return {
      access_token: stored.accessToken,
      token_type: "Bearer",
      refresh_token: stored.refreshToken,
      expires_in: stored.expiresAt ? Math.max(0, Math.floor(stored.expiresAt - Date.now() / 1000)) : undefined,
      scope: stored.scope,
    };
  }

  saveTokens(tokens: OAuthTokens): void {
    saveTokens(SERVER_NAME, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
      scope: tokens.scope,
    });
  }

  saveCodeVerifier(verifier: string): void {
    saveCodeVerifier(SERVER_NAME, verifier);
  }

  codeVerifier(): string {
    const v = getCodeVerifier(SERVER_NAME);
    if (!v) throw new Error("No PKCE code verifier saved for Linear MCP.");
    return v;
  }

  saveState(state: string): void {
    saveOAuthState(SERVER_NAME, state);
  }

  state(): string {
    // The SDK runtime checks `provider.state ? await provider.state() : undefined`
    // so returning undefined here is safe — the interface types are stricter than the runtime.
    return getOAuthState(SERVER_NAME) ?? (undefined as unknown as string);
  }

  invalidateCredentials(type: "all" | "client" | "tokens"): void {
    if (type === "all") clearAll(SERVER_NAME);
    else if (type === "client") clearClientInfo(SERVER_NAME);
    else clearTokens(SERVER_NAME);
  }

  /**
   * Called by the SDK when a fresh authorization code flow is needed.
   * Starts the callback server HERE (not before) so port 19876 is only
   * bound when we actually need the browser flow.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) {
      // Reject immediately so the transport's re-auth fails fast with a clear message.
      const rejection = Promise.reject(
        new Error("Linear tokens expired or missing. Run `linear-pi auth login` from an interactive terminal to re-authenticate."),
      );
      rejection.catch(() => {}); // avoid an unhandled rejection warning if pendingCallback() is never awaited
      this._callbackPromise = rejection;
      return;
    }
    this.didRedirect = true;
    this._callbackPromise = waitForOAuthCallback();
    process.stderr.write(`\nLinear authentication required.\nOpen this URL in your browser:\n\n  ${authorizationUrl.toString()}\n`);
    // Only attempt to open the browser on macOS/Windows — on Linux xdg-open
    // is frequently absent (especially on VPS) and emits an unhandled child
    // process error event that can't be caught with try/catch.
    if (process.platform !== "linux") {
      try {
        const { default: open } = await import("open");
        await open(authorizationUrl.toString());
      } catch {
        // ignore — URL already printed above
      }
    }
  }

  pendingCallback(): Promise<{ code: string; state: string }> {
    if (!this._callbackPromise) throw new Error("No pending OAuth callback — redirectToAuthorization was not called.");
    return this._callbackPromise;
  }
}

// ── Callback server + manual paste (VPS fallback) ────────────────────────────

/**
 * Waits for the OAuth callback two ways simultaneously:
 *  1. HTTP server on port 19876 — works when browser is on the same machine.
 *  2. Manual paste from stdin — works on a VPS/headless environment where the
 *     user opens the URL on their laptop, sees the browser fail to connect to
 *     localhost:19876, copies that URL from the address bar, and pastes it here.
 */
function waitForOAuthCallback(): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let server: http.Server | undefined;
    let rl: readline.Interface | undefined;
    const timeout = setTimeout(() => finish(new Error("OAuth callback timed out after 5 minutes.")), 5 * 60 * 1000);

    function finish(result: { code: string; state: string } | Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { server?.close(); } catch {}
      try { rl?.close(); } catch {}
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    function parseCallbackUrl(raw: string): { code: string; state: string } | null {
      try {
        const url = new URL(raw.trim());
        const code = url.searchParams.get("code");
        if (!code) return null;
        // state may be absent if provider.state() returned undefined (no saved state)
        const state = url.searchParams.get("state") ?? "";
        return { code, state };
      } catch {}
      return null;
    }

    // 1. Try HTTP server (desktop / local use)
    server = http.createServer((req, res) => {
      const parsed = parseCallbackUrl(`http://localhost${req.url}`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body style='font-family:sans-serif;padding:2rem'><h1>✓ Authorized</h1><p>You can close this tab and return to the terminal.</p></body></html>");
      if (parsed) finish(parsed);
      else finish(new Error("OAuth callback is missing code or state parameters."));
    });
    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1");
    server.once("error", () => {
      // Port in use — fall back to manual paste only (no hard failure)
      server = undefined;
      process.stderr.write(`(Port ${OAUTH_CALLBACK_PORT} in use — waiting for manual paste only)\n`);
    });

    // 2. Always also accept manual paste from stdin (VPS / remote use)
    process.stderr.write(
      `\nOn a VPS or remote machine, open the URL above on any device.\n` +
      `When your browser shows "This site can't be reached", copy the full URL\n` +
      `from the address bar (starts with http://localhost:${OAUTH_CALLBACK_PORT}/callback?code=...)\n` +
      `and paste it here, then press Enter:\n> `,
    );
    rl = readline.createInterface({ input: process.stdin });
    rl.once("line", (line) => {
      const parsed = parseCallbackUrl(line);
      if (parsed) finish(parsed);
      else finish(new Error(`Could not parse code/state from: ${line}`));
    });
  });
}

// ── Config discovery ──────────────────────────────────────────────────────────

function readLinearMcpUrl(): string {
  const configPaths = [
    path.join(os.homedir(), ".config", "mcp", "mcp.json"),
    path.join(os.homedir(), ".mcp.json"),
    path.join(os.homedir(), ".claude.json"),
    path.join(os.homedir(), ".claude", "mcp.json"),
  ];
  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const servers = data?.mcpServers ?? {};
      for (const server of Object.values(servers) as any[]) {
        if (server?.url && String(server.url).includes("linear")) return server.url as string;
      }
    } catch {}
  }
  return LINEAR_MCP_URL;
}

// ── MCP JSON parsing ──────────────────────────────────────────────────────────

function parseMcpJson<T>(result: any): T {
  const text = (result?.content || [])
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p.text)
    .join("\n")
    .trim();
  if (!text) return result as T;
  try { return JSON.parse(text) as T; } catch { return text as T; }
}

// ── Linear client ─────────────────────────────────────────────────────────────

export class SdkMcpLinearClient implements LinearClient {
  private client: Client | undefined;
  private readonly authProvider: LinearOAuthProvider;
  private readonly serverUrl: string;
  private readonly interactive: boolean;

  /** @param interactive Set false in daemon mode to prevent interactive auth prompts. */
  constructor({ interactive = true }: { interactive?: boolean } = {}) {
    this.serverUrl = readLinearMcpUrl();
    this.interactive = interactive;
    this.authProvider = new LinearOAuthProvider({ interactive });
  }

  private createTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(this.serverUrl), {
      authProvider: this.authProvider,
    });
  }

  /**
   * Two-phase OAuth flow:
   *  Phase 1 — provider.redirectToAuthorization() is called by SDK, which opens browser.
   *  Phase 2 — we exchange the auth code received at the callback server.
   */
  private async authenticate(): Promise<void> {
    // Phase 1: SDK calls redirectToAuthorization() only if tokens are missing/expired.
    // The callback server is started inside redirectToAuthorization(), NOT here,
    // so port 19876 is never bound when tokens are already valid.
    const phase1Result = await runSdkAuth(this.authProvider, { serverUrl: new URL(this.serverUrl) });
    if (phase1Result === "AUTHORIZED") return;

    // Phase 2: browser opened, wait for the callback the server is already listening for
    process.stderr.write("Waiting for authorization callback...\n");
    const { code } = await this.authProvider.pendingCallback();

    await runSdkAuth(this.authProvider, {
      serverUrl: new URL(this.serverUrl),
      authorizationCode: code,
    });
  }

  /** Returns stored token metadata (for `linear-pi auth status`), without making a network call. */
  tokenInfo(): StoredTokens | undefined {
    return getTokens(SERVER_NAME);
  }

  /**
   * Reports whether we hold tokens that look usable — purely a local check
   * against stored state. Does NOT make a network call: connecting with the
   * real auth provider would itself kick off the interactive redirect flow
   * as a side effect (the SDK's transport does this internally on 401),
   * which is exactly what a passive status check must not do.
   */
  checkAuth(): boolean {
    const stored = getTokens(SERVER_NAME);
    if (!stored?.accessToken) return false;
    if (stored.refreshToken) return true; // refreshable even if the access token expired
    return stored.expiresAt === undefined || stored.expiresAt * 1000 > Date.now();
  }

  /**
   * Explicit login for `linear-pi auth login`. Handles both:
   *  - Local machine with a browser: opens the authorization URL automatically.
   *  - Headless/VPS: prints the URL to open elsewhere and accepts the callback
   *    URL pasted back into the terminal (see waitForOAuthCallback).
   */
  async login(opts: { force?: boolean } = {}): Promise<"already-authenticated" | "authenticated"> {
    if (opts.force) {
      this.authProvider.invalidateCredentials("all");
      this.client = undefined;
    }
    this.authProvider.didRedirect = false;
    await this.authenticate();
    await this.getClient();
    return this.authProvider.didRedirect ? "authenticated" : "already-authenticated";
  }

  /** Removes stored Linear credentials. */
  logout(): void {
    this.client = undefined;
    this.authProvider.invalidateCredentials("all");
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;

    const transport = this.createTransport();
    const client = new Client({ name: "linear-pi-cli", version: "0.1.0" }, {});

    try {
      await client.connect(transport);
      this.client = client;
      return client;
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        if (!this.interactive) {
          throw new Error(
            "Linear tokens expired or missing. Run `linear-pi auth login` from an interactive " +
            "terminal, then restart the watcher with `linear-pi watch start`.",
          );
        }
        await this.authenticate();
        // Reconnect with fresh transport now that we have tokens
        const freshTransport = this.createTransport();
        const freshClient = new Client({ name: "linear-pi-cli", version: "0.1.0" }, {});
        await freshClient.connect(freshTransport);
        this.client = freshClient;
        return freshClient;
      }
      throw error;
    }
  }

  private async callTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.getClient();
    const result = await client.callTool({ name: toolName, arguments: args });
    if ((result as any).isError) throw new Error(JSON.stringify(result));
    return parseMcpJson<T>(result);
  }

  private async callToolRaw(toolName: string, args: Record<string, unknown>): Promise<any> {
    const client = await this.getClient();
    const result = await client.callTool({ name: toolName, arguments: args });
    if ((result as any).isError) throw new Error(JSON.stringify(result));
    return result;
  }

  async listIssues(args: ListIssuesArgs): Promise<LinearIssue[]> {
    const response = await this.callTool<LinearIssue[] | { issues?: LinearIssue[] }>("list_issues", args as any);
    return Array.isArray(response) ? response : response.issues || [];
  }

  async getIssue(id: string): Promise<LinearIssue> {
    return this.callTool<LinearIssue>("get_issue", { id });
  }

  async saveIssue(args: SaveIssueArgs): Promise<void> {
    await this.callTool("save_issue", args as any);
  }

  async saveComment(issueId: string, body: string): Promise<void> {
    await this.callTool("save_comment", { issueId, body });
  }

  async getAttachment(id: string): Promise<unknown> {
    return this.callTool("get_attachment", { id });
  }

  async extractImages(markdown: string): Promise<ExtractedImage[]> {
    const result = await this.callToolRaw("extract_images", { markdown });
    return (result?.content || [])
      .filter((p: any) => p?.type === "image" && typeof p.data === "string")
      .map((p: any) => ({ data: p.data as string, mimeType: p.mimeType as string }));
  }

  async shutdown(): Promise<void> {
    try { await this.client?.close(); } catch {}
    this.client = undefined;
  }
}
