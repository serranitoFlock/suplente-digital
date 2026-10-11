import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMcpToolsConfig, resolveToolMappings, type ToolMapping } from "../src/tools/mcp-config.js";
import { McpToolProvider } from "../src/tools/mcp-provider.js";
import { ToolCallError, ToolNotAllowedError, type ToolName } from "../src/tools/types.js";

/** Spawns the fake server through the real stdio transport (`node --import tsx`, no build step). */
const SERVER = { command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL("./fixtures/fake-mcp-server.ts", import.meta.url))] };

const envNames: Record<ToolName, string> = { get_ticket: "get_issue", search_tickets: "search_issues", list_failed_pipelines: "list_failed_pipelines" };

const mappings = (tools: Record<string, unknown>): Record<ToolName, ToolMapping> =>
  resolveToolMappings(envNames, parseMcpToolsConfig({ tools }));

const atlassian = {
  get_ticket: { name: "jira_get_issue", args: { issue_key: { arg: "key" } } },
  search_tickets: { name: "jira_search", args: { jql: { template: 'text ~ "{query}" ORDER BY updated DESC' }, limit: { value: 5 } } },
  list_failed_pipelines: { name: "gitlab_list_failed_jobs", args: { days: { arg: "sinceDays" }, project: { value: "acme/web-components" } } },
};

/** Maps `search_tickets` onto one of the fake's failure tools; the rest stay valid. */
const searchVia = (name: string) => mappings({ ...atlassian, search_tickets: { name, args: { jql: { template: "{query}" } } } });

describe("McpToolProvider against a fake stdio MCP server", () => {
  let provider: McpToolProvider | undefined;
  const connect = async (toolMappings: Record<ToolName, ToolMapping>, timeoutMs = 5_000) => {
    provider = await McpToolProvider.connect(SERVER.command, SERVER.args, toolMappings, { timeoutMs });
    return provider;
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await provider?.close().catch(() => undefined);
    provider = undefined;
    vi.restoreAllMocks();
  });

  it("calls the mapped remote tools with renamed, literal and templated arguments", async () => {
    const mcp = await connect(mappings(atlassian));
    expect(JSON.parse(await mcp.call({ tool: "get_ticket", args: { key: "DEMO-101" } }))).toMatchObject({
      tool: "jira_get_issue",
      received: { issue_key: "DEMO-101" },
    });
    expect(JSON.parse(await mcp.call({ tool: "search_tickets", args: { query: 'cdn" OR x' } }))).toMatchObject({
      tool: "jira_search",
      received: { jql: 'text ~ "cdn\\" OR x" ORDER BY updated DESC', limit: 5 },
    });
    expect(JSON.parse(await mcp.call({ tool: "list_failed_pipelines", args: { sinceDays: 3 } }))).toMatchObject({
      tool: "gitlab_list_failed_jobs",
      received: { days: 3, project: "acme/web-components" },
    });
  });

  it("refuses to start when a mapping points at a destructive remote tool", async () => {
    await expect(connect(mappings({ ...atlassian, get_ticket: { name: "jira_update_issue", args: { issue_key: { arg: "key" } } } }))).rejects.toThrow(
      ToolNotAllowedError,
    );
  });

  it("reports a remote tool the server does not expose as a tool failure", async () => {
    const mcp = await connect(mappings({ ...atlassian, get_ticket: { name: "jira_missing_tool" } }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("jira_missing_tool"));
    await expect(mcp.call({ tool: "get_ticket", args: { key: "DEMO-101" } })).rejects.toMatchObject({ name: "ToolCallError", kind: "missing_tool" });
  });

  it("times out a slow tool", async () => {
    const mcp = await connect(searchVia("slow_search"), 300);
    await expect(mcp.call({ tool: "search_tickets", args: { query: "cdn" } })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("turns an isError result into a tool failure without leaking the remote text", async () => {
    const mcp = await connect(searchVia("failing_search"));
    const error = await mcp.call({ tool: "search_tickets", args: { query: "cdn" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallError);
    expect(error).toMatchObject({ kind: "remote_error" });
    expect(String((error as Error).message)).not.toContain("fake-secret-123");
  });

  it("reports a crashed server as unavailable, also for later calls", async () => {
    const mcp = await connect(searchVia("crash_search"));
    await expect(mcp.call({ tool: "search_tickets", args: { query: "cdn" } })).rejects.toMatchObject({ kind: "unavailable" });
    await expect(mcp.call({ tool: "get_ticket", args: { key: "DEMO-101" } })).rejects.toMatchObject({ kind: "unavailable" });
  });
});
