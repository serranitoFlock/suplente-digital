import { describe, expect, it } from "vitest";
import { McpToolProvider, type McpClientLike, type McpRemoteTool } from "../src/tools/mcp-provider.js";
import { TOOL_POLICIES, ToolCallError, ToolNotAllowedError, assertToolAllowed, isAutoRunnable, parseToolCall, type ToolCall, type ToolName } from "../src/tools/types.js";

const toolNames: Record<ToolName, string> = {
  get_ticket: "get_issue",
  search_tickets: "search_issues",
  list_failed_pipelines: "list_failed_pipelines",
};

function fakeClient(tools: McpRemoteTool[], calls: string[] = []): McpClientLike {
  return {
    listTools: async () => ({ tools }),
    callTool: async ({ name }) => {
      calls.push(name);
      return { content: [{ type: "text", text: `ok:${name}` }] };
    },
    close: async () => undefined,
  };
}

const remote = (overrides: Partial<Record<string, McpRemoteTool["annotations"]>> = {}): McpRemoteTool[] =>
  [...Object.values(toolNames), "delete_issue"].map((name) => ({ name, annotations: overrides[name] }));

describe("tool allowlist", () => {
  it("declares every catalog tool as read-only with an explicit permission", () => {
    for (const policy of Object.values(TOOL_POLICIES)) {
      expect(policy.readOnly).toBe(true);
      expect(["always_allow", "always_ask"]).toContain(policy.permission);
    }
  });

  it("refuses tools outside the allowlist", () => {
    expect(() => assertToolAllowed("delete_ticket")).toThrow(ToolNotAllowedError);
    expect(() => assertToolAllowed("get_ticket")).not.toThrow();
  });

  it("declares run_script as a read-only, unattended catalog tool", () => {
    expect(TOOL_POLICIES.run_script).toEqual({ readOnly: true, permission: "always_allow" });
    expect(parseToolCall('{"tool":"run_script","args":{"script":"failed-jobs","args":{"days":3}}}')).toEqual({
      tool: "run_script",
      args: { script: "failed-jobs", args: { days: 3 } },
    });
    expect(parseToolCall('{"tool":"run_script","args":{"args":{}}}')).toBeNull();
  });

  it("only auto-runs always_allow tools", () => {
    expect(isAutoRunnable("get_ticket")).toBe(true);
    expect(isAutoRunnable("get_ticket", { ...TOOL_POLICIES, get_ticket: { ...TOOL_POLICIES.get_ticket, permission: "always_ask" } })).toBe(false);
  });
});

describe("McpToolProvider (fake MCP client)", () => {
  it("maps allowlisted calls to the remote tool names", async () => {
    const calls: string[] = [];
    const provider = await McpToolProvider.fromClient(fakeClient(remote(), calls), toolNames);
    expect(await provider.call({ tool: "get_ticket", args: { key: "DEMO-1" } })).toBe("ok:get_issue");
    expect(calls).toEqual(["get_issue"]);
  });

  it("refuses a tool that is not in the allowlist even if the server exposes it", async () => {
    const calls: string[] = [];
    const provider = await McpToolProvider.fromClient(fakeClient(remote(), calls), toolNames);
    const sneaky = { tool: "delete_ticket", args: { key: "DEMO-1" } } as unknown as ToolCall;
    await expect(provider.call(sneaky)).rejects.toThrow(ToolNotAllowedError);
    expect(calls).toEqual([]);
  });

  it("refuses to start when a mapped remote tool is annotated as destructive or not read-only", async () => {
    await expect(
      McpToolProvider.fromClient(fakeClient(remote({ get_issue: { destructiveHint: true } })), toolNames),
    ).rejects.toThrow(/get_issue/);
    await expect(
      McpToolProvider.fromClient(fakeClient(remote({ search_issues: { readOnlyHint: false } })), toolNames),
    ).rejects.toThrow(/search_issues/);
  });

  it("checks the annotations of the remote tool named by a full mapping and closes the client", async () => {
    let closed = false;
    const client = { ...fakeClient([{ name: "jira_update_issue", annotations: { destructiveHint: true } }]), close: async () => void (closed = true) };
    const mapping = { ...toolNames, get_ticket: { name: "jira_update_issue", args: { issue_key: { arg: "key" } } } };
    await expect(McpToolProvider.fromClient(client, mapping)).rejects.toThrow(/jira_update_issue/);
    expect(closed).toBe(true);
  });

  it("never maps run_script to an MCP tool and never sends it to the server", async () => {
    const calls: string[] = [];
    const mapping = { ...toolNames, run_script: "run_anything" } as unknown as Record<ToolName, string>;
    await expect(McpToolProvider.fromClient(fakeClient(remote(), calls), mapping)).rejects.toThrow(ToolNotAllowedError);
    const provider = await McpToolProvider.fromClient(fakeClient(remote(), calls), toolNames);
    await expect(provider.call({ tool: "run_script", args: { script: "x", args: {} } })).rejects.toThrow(ToolCallError);
    expect(calls).toEqual([]);
  });

  it("refuses a mapping for a local tool name outside the allowlist", async () => {
    const mapping = { ...toolNames, delete_ticket: "delete_issue" } as unknown as Record<ToolName, string>;
    await expect(McpToolProvider.fromClient(fakeClient(remote()), mapping)).rejects.toThrow(ToolNotAllowedError);
  });
});
