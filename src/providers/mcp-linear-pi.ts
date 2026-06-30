import { McpServerManager } from "/home/claude-user/.pi/agent/npm/node_modules/pi-mcp-adapter/server-manager.ts";
import { loadMcpConfig } from "/home/claude-user/.pi/agent/npm/node_modules/pi-mcp-adapter/config.ts";
import type { ServerEntry } from "/home/claude-user/.pi/agent/npm/node_modules/pi-mcp-adapter/types.ts";
import type { LinearClient } from "./linear.js";
import type { LinearIssue, ListIssuesArgs, SaveIssueArgs, ExtractedImage } from "../types.js";

function parseMcpJson<T>(result: any): T {
  const text = (result?.content || [])
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p.text)
    .join("\n")
    .trim();
  if (!text) return result as T;
  try { return JSON.parse(text) as T; } catch { return text as T; }
}

export class PiMcpLinearClient implements LinearClient {
  private manager = new McpServerManager();
  private mcpServer = process.env.LINEAR_PI_MCP_SERVER || "linear";
  private repoRoot: string | undefined;

  setRepoRoot(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  private async callTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    const mcpConfig = loadMcpConfig(undefined, this.repoRoot);
    const definition = mcpConfig.mcpServers[this.mcpServer] as ServerEntry | undefined;
    if (!definition) throw new Error(`MCP server "${this.mcpServer}" not found in MCP config.`);

    const connection = await this.manager.connect(this.mcpServer, definition);
    if (connection.status === "needs-auth") {
      throw new Error(`Linear MCP needs auth. In Pi, run: mcp({ action: "auth-start", server: "${this.mcpServer}" })`);
    }

    this.manager.touch(this.mcpServer);
    this.manager.incrementInFlight(this.mcpServer);
    try {
      const result = await connection.client.callTool({ name: toolName, arguments: args });
      if ((result as any).isError) throw new Error(JSON.stringify(result));
      return parseMcpJson<T>(result);
    } finally {
      this.manager.decrementInFlight(this.mcpServer);
      this.manager.touch(this.mcpServer);
    }
  }

  private async callToolRaw(toolName: string, args: Record<string, unknown>): Promise<any> {
    const mcpConfig = loadMcpConfig(undefined, this.repoRoot);
    const definition = mcpConfig.mcpServers[this.mcpServer] as ServerEntry | undefined;
    if (!definition) throw new Error(`MCP server "${this.mcpServer}" not found in MCP config.`);

    const connection = await this.manager.connect(this.mcpServer, definition);
    if (connection.status === "needs-auth") {
      throw new Error(`Linear MCP needs auth. In Pi, run: mcp({ action: "auth-start", server: "${this.mcpServer}" })`);
    }

    this.manager.touch(this.mcpServer);
    this.manager.incrementInFlight(this.mcpServer);
    try {
      const result = await connection.client.callTool({ name: toolName, arguments: args });
      if ((result as any).isError) throw new Error(JSON.stringify(result));
      return result;
    } finally {
      this.manager.decrementInFlight(this.mcpServer);
      this.manager.touch(this.mcpServer);
    }
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
    await this.manager.closeAll().catch(() => {});
  }
}
