import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AppConfig } from "../config.js";
import { MockToolProvider } from "./mock-provider.js";
import type { ToolCall, ToolName, ToolProvider } from "./types.js";

/**
 * Stub provider backed by an MCP server (e.g. a Jira or GitLab MCP server).
 * Only the read-only tools mapped in config are ever invoked; anything else is refused.
 */
export class McpToolProvider implements ToolProvider {
  readonly name = "mcp";

  private constructor(
    private readonly client: Client,
    private readonly toolNames: Record<ToolName, string>,
  ) {}

  static async connect(command: string, args: string[], toolNames: Record<ToolName, string>): Promise<McpToolProvider> {
    const client = new Client({ name: "suplente-digital", version: "0.1.0" });
    await client.connect(new StdioClientTransport({ command, args }));
    const available = new Set((await client.listTools()).tools.map((t) => t.name));
    const missing = Object.values(toolNames).filter((name) => !available.has(name));
    if (missing.length) console.warn(`[mcp] Server does not expose: ${missing.join(", ")}`);
    return new McpToolProvider(client, toolNames);
  }

  async call(call: ToolCall): Promise<string> {
    const result = await this.client.callTool({ name: this.toolNames[call.tool], arguments: call.args });
    const content = Array.isArray(result.content) ? result.content : [];
    return content
      .map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : `[${block.type}]`))
      .join("\n");
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Uses MCP when MCP_SERVER_COMMAND is configured, otherwise the credential-free mock. */
export async function createToolProvider(mcp: AppConfig["mcp"]): Promise<ToolProvider> {
  if (!mcp.command) return new MockToolProvider();
  return McpToolProvider.connect(mcp.command, [...mcp.args], { ...mcp.toolNames });
}
