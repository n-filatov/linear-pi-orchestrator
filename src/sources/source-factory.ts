import type { WorkSource } from "../domain/index.js";
import { CommandWorkSource, type CommandRunner, type CommandSourceConfig } from "./command-source.js";
import { LinearMcpSource, type LinearMcpSourceConfig } from "./linear-mcp-source.js";
import type { McpToolClient } from "./mcp-tool-client.js";

export type SourceDefinition =
  | ({ type: "linear-mcp" } & Omit<LinearMcpSourceConfig, "client">)
  | ({ type: "command" } & CommandSourceConfig);

export interface SourceFactoryDependencies {
  /** Required by a Linear source and intentionally injectable for OAuth/session ownership. */
  mcpClient?: McpToolClient;
  commandRunner?: CommandRunner;
}

export function createWorkSource(definition: SourceDefinition, dependencies: SourceFactoryDependencies = {}): WorkSource {
  switch (definition.type) {
    case "linear-mcp": {
      if (!dependencies.mcpClient) {
        throw new Error("A Linear MCP source requires an injected McpToolClient");
      }
      return new LinearMcpSource({ ...definition, client: dependencies.mcpClient });
    }
    case "command":
      return new CommandWorkSource(definition, dependencies.commandRunner);
  }
}
