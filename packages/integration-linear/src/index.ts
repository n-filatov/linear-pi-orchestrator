import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Small MCP seam: source adapters can be tested without an MCP transport. */
export interface McpToolClient {
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close?(): Promise<void>;
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export type McpTransportConfig =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  | {
      transport: "streamable-http";
      url: string;
      headers?: Record<string, string>;
    };

export interface SdkMcpToolClientOptions {
  clientName: string;
  clientVersion: string;
  transport: McpTransportConfig;
}

/**
 * Concrete SDK transport implementation for stdio and Streamable HTTP MCP.
 * OAuth is intentionally not configured here: inject a pre-authenticated
 * McpToolClient (or an SDK transport with an auth provider) for that policy.
 */
export class SdkMcpToolClient implements McpToolClient {
  private constructor(private readonly client: Client) {}

  public static async connect(options: SdkMcpToolClientOptions): Promise<SdkMcpToolClient> {
    const client = new Client({ name: options.clientName, version: options.clientVersion });
    const transport = options.transport.transport === "stdio"
      ? new StdioClientTransport({
          command: options.transport.command,
          args: options.transport.args,
          cwd: options.transport.cwd,
          env: options.transport.env,
          // MCP servers reserve stdout for protocol messages, but many proxy
          // tools also write verbose connection traces to stderr. The SDK
          // inherits stderr by default, which floods Relay's dashboard pane
          // with OAuth/JSON-RPC chatter on every poll. Connection failures
          // still surface through `client.connect` / `callTool` and are logged
          // by Relay with the source, ticket, and actionable error.
          stderr: "ignore",
        })
      : new StreamableHTTPClientTransport(new URL(options.transport.url), {
          requestInit: options.transport.headers ? { headers: options.transport.headers } : undefined,
        });
    await client.connect(transport);
    return new SdkMcpToolClient(client);
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return await this.client.callTool({ name, arguments: args }) as McpToolResult;
  }

  public async close(): Promise<void> {
    await this.client.close();
  }
}

/** Returns structured tool output when available, otherwise parses its text result as JSON. */
export function readMcpJson(result: McpToolResult): unknown {
  if (result.isError) throw new Error(`MCP tool returned an error: ${JSON.stringify(result)}`);
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned neither structuredContent nor text JSON");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("MCP tool text content is not valid JSON");
  }
}
