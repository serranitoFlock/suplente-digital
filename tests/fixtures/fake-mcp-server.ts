/**
 * Fake stdio MCP server for integration tests (fictional data only).
 *
 * Its tools deliberately use other names and argument names than our local catalog, like the real
 * Atlassian/GitLab MCP servers do. Read tools echo the arguments they received so tests can assert
 * the mapping. Extra tools cover the failure paths: a destructive write tool, a slow tool, a tool
 * that answers with `isError` and a tool that crashes the process.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-atlassian-gitlab", version: "0.0.1" });
const readOnly = { readOnlyHint: true, destructiveHint: false };
const echo = (tool: string, args: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ tool, received: args, host: "https://jira.example.com" }) }],
});

server.registerTool("jira_get_issue", { inputSchema: { issue_key: z.string() }, annotations: readOnly }, async (args) => echo("jira_get_issue", args));
server.registerTool(
  "jira_search",
  { inputSchema: { jql: z.string(), limit: z.number().optional() }, annotations: readOnly },
  async (args) => echo("jira_search", args),
);
server.registerTool(
  "gitlab_list_failed_jobs",
  { inputSchema: { days: z.number(), project: z.string() }, annotations: readOnly },
  async (args) => echo("gitlab_list_failed_jobs", args),
);
server.registerTool(
  "jira_update_issue",
  { inputSchema: { issue_key: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true } },
  async () => echo("jira_update_issue", { written: true }),
);
server.registerTool("slow_search", { inputSchema: { jql: z.string() }, annotations: readOnly }, async (args) => {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  return echo("slow_search", args);
});
server.registerTool("failing_search", { inputSchema: { jql: z.string() }, annotations: readOnly }, async () => ({
  isError: true,
  content: [{ type: "text" as const, text: "Remote failure: token=fake-secret-123 at /internal/stack" }],
}));
server.registerTool("crash_search", { inputSchema: { jql: z.string() }, annotations: readOnly }, async () => process.exit(1));

await server.connect(new StdioServerTransport());
