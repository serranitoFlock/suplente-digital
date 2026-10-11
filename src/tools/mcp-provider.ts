import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { DEFAULT_CALL_TIMEOUT_MS, loadMcpToolsConfig, mapToolArgs, resolveToolMappings, type ToolMapping } from "./mcp-config.js";
import { MockToolProvider } from "./mock-provider.js";
import { withScripts } from "./script-provider.js";
import { loadScriptRegistry } from "./scripts.js";
import {
  assertToolAllowed,
  SCRIPT_TOOL,
  ToolCallError,
  ToolNotAllowedError,
  type ToolCall,
  type ToolFailureKind,
  type ToolName,
  type ToolProvider,
} from "./types.js";

/** A tool as listed by an MCP server (only the fields the allowlist checks). */
export interface McpRemoteTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** The slice of the MCP SDK client this provider uses; tests plug in a fake. */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpRemoteTool[] }>;
  callTool(
    request: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ content?: unknown; isError?: unknown }>;
  close(): Promise<void>;
}

export interface McpProviderOptions {
  /** Per-call timeout in milliseconds (`MCP_CALL_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/** A local tool maps to a remote tool name (identity arguments) or to a full `ToolMapping`. */
export type McpToolMappings = Record<ToolName, string | ToolMapping>;

class CallTimeout extends Error {}

/** Classifies a failed `callTool`: our timer or the SDK's timeout, a closed connection, or a JSON-RPC error. */
function failureKind(error: unknown): ToolFailureKind {
  if (error instanceof CallTimeout) return "timeout";
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) return "timeout";
    if (error.code !== ErrorCode.ConnectionClosed) return "remote_error";
  }
  return "unavailable";
}

/**
 * Provider backed by an MCP server (e.g. a Jira or GitLab MCP server).
 *
 * Least privilege: only the allowlisted read-only tools (`TOOL_POLICIES`) can be mapped or called.
 * The server may expose write tools; they are never invoked. On startup the provider refuses to run
 * if a mapped remote tool declares itself destructive or not read-only (MCP tool annotations).
 *
 * Resilience: every call has a timeout, and a missing remote tool, a timeout, a crashed server or an
 * `isError` result surface as `ToolCallError` so the task node can answer gracefully.
 */
export class McpToolProvider implements ToolProvider {
  readonly name = "mcp";

  private constructor(
    private readonly client: McpClientLike,
    private readonly mappings: Record<ToolName, ToolMapping>,
    private readonly available: ReadonlySet<string>,
    private readonly timeoutMs: number,
  ) {}

  static async connect(command: string, args: string[], mappings: McpToolMappings, options: McpProviderOptions = {}): Promise<McpToolProvider> {
    const client = new Client({ name: "suplente-digital", version: "0.1.0" });
    await client.connect(new StdioClientTransport({ command, args }));
    return McpToolProvider.fromClient(client as unknown as McpClientLike, mappings, options);
  }

  /** Validates the mapping against the allowlist and the server's tool annotations. */
  static async fromClient(client: McpClientLike, mappings: McpToolMappings, options: McpProviderOptions = {}): Promise<McpToolProvider> {
    const normalized = Object.fromEntries(
      Object.entries(mappings).map(([local, mapping]) => [local, typeof mapping === "string" ? { name: mapping } : mapping]),
    ) as Record<ToolName, ToolMapping>;

    let remote: Map<string, McpRemoteTool>;
    try {
      for (const local of Object.keys(normalized)) {
        assertToolAllowed(local);
        if (local === SCRIPT_TOOL) throw new ToolNotAllowedError(local, "is served by the script registry, never by an MCP server");
      }
      remote = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      for (const [local, { name }] of Object.entries(normalized)) {
        const hints = remote.get(name)?.annotations;
        if (hints?.destructiveHint === true || hints?.readOnlyHint === false) {
          throw new ToolNotAllowedError(`${local} → ${name}`, "maps to a remote tool that is not declared read-only");
        }
      }
    } catch (error) {
      await client.close();
      throw error;
    }
    const missing = Object.values(normalized).filter(({ name }) => !remote.has(name));
    if (missing.length) console.warn(`[mcp] Server does not expose: ${missing.map(({ name }) => name).join(", ")}`);
    return new McpToolProvider(client, normalized, new Set(remote.keys()), options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  }

  async call(call: ToolCall): Promise<string> {
    // Defense in depth: `parseToolCall` already validates, but never trust the caller here.
    assertToolAllowed(call.tool);
    if (call.tool === SCRIPT_TOOL) throw new ToolCallError(call.tool, "missing_tool");
    const mapping = this.mappings[call.tool];
    if (!this.available.has(mapping.name)) throw new ToolCallError(call.tool, "missing_tool");

    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new CallTimeout());
      }, this.timeoutMs);
    });
    let result: Awaited<ReturnType<McpClientLike["callTool"]>>;
    try {
      const request = { name: mapping.name, arguments: mapToolArgs(mapping, call.args) };
      result = await Promise.race([this.client.callTool(request, undefined, { signal: abort.signal, timeout: this.timeoutMs }), timeout]);
    } catch (error) {
      throw new ToolCallError(call.tool, failureKind(error));
    } finally {
      clearTimeout(timer);
    }
    // The error text comes from the remote server: never copy it into our error or the reply.
    if (result.isError === true) throw new ToolCallError(call.tool, "remote_error");

    const content = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]) : [];
    return content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Uses MCP when MCP_SERVER_COMMAND is configured, otherwise the credential-free mock.
 * Tool names and arguments come from the optional mapping file (`MCP_TOOLS_CONFIG`), else from `MCP_TOOL_*`.
 * With a script registry (`SCRIPTS_CONFIG`) that registers at least one script, `run_script` goes to the
 * script runner and every other tool to that provider.
 */
export async function createToolProvider(mcp: AppConfig["mcp"], scripts?: AppConfig["scripts"]): Promise<ToolProvider> {
  const registry = scripts ? await loadScriptRegistry(scripts.configPath, scripts.root) : undefined;
  let base: ToolProvider;
  if (!mcp.command) base = new MockToolProvider();
  else {
    const mappings = resolveToolMappings({ ...mcp.toolNames }, await loadMcpToolsConfig(mcp.toolsConfigPath));
    base = await McpToolProvider.connect(mcp.command, [...mcp.args], mappings, { timeoutMs: mcp.callTimeoutMs });
  }
  return registry ? withScripts(base, registry) : base;
}
