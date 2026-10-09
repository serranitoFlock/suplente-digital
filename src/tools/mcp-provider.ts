import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AppConfig } from "../config.js";
import { MockToolProvider } from "./mock-provider.js";
import { assertToolAllowed, ToolNotAllowedError, type ToolCall, type ToolName, type ToolProvider } from "./types.js";

/** A tool as listed by an MCP server (only the fields the allowlist checks). */
export interface McpRemoteTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** The slice of the MCP SDK client this provider uses; tests plug in a fake. */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpRemoteTool[] }>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<{ content?: unknown }>;
  close(): Promise<void>;
}

/**
 * Provider backed by an MCP server (e.g. a Jira or GitLab MCP server).
 *
 * Least privilege: only the allowlisted read-only tools (`TOOL_POLICIES`) can be mapped or called.
 * The server may expose write tools; they are never invoked. On startup the provider refuses to run
 * if a mapped remote tool declares itself destructive or not read-only (MCP tool annotations).
 */
export class McpToolProvider implements ToolProvider {
  readonly name = "mcp";

  private constructor(
    private readonly client: McpClientLike,
    private readonly toolNames: Record<ToolName, string>,
  ) {}

  static async connect(command: string, args: string[], toolNames: Record<ToolName, string>): Promise<McpToolProvider> {
    const client = new Client({ name: "suplente-digital", version: "0.1.0" });
    await client.connect(new StdioClientTransport({ command, args }));
    return McpToolProvider.fromClient(client as unknown as McpClientLike, toolNames);
  }

  /** Validates the mapping against the allowlist and the server's tool annotations. */
  static async fromClient(client: McpClientLike, toolNames: Record<ToolName, string>): Promise<McpToolProvider> {
    for (const local of Object.keys(toolNames)) assertToolAllowed(local);

    const remote = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    for (const [local, remoteName] of Object.entries(toolNames)) {
      const hints = remote.get(remoteName)?.annotations;
      if (hints?.destructiveHint === true || hints?.readOnlyHint === false) {
        await client.close();
        throw new ToolNotAllowedError(`${local} → ${remoteName}`, "maps to a remote tool that is not declared read-only");
      }
    }
    const missing = Object.values(toolNames).filter((name) => !remote.has(name));
    if (missing.length) console.warn(`[mcp] Server does not expose: ${missing.join(", ")}`);
    return new McpToolProvider(client, toolNames);
  }

  async call(call: ToolCall): Promise<string> {
    // Defense in depth: `parseToolCall` already validates, but never trust the caller here.
    assertToolAllowed(call.tool);
    const result = await this.client.callTool({ name: this.toolNames[call.tool], arguments: call.args });
    const content = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]) : [];
    return content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
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
