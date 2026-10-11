import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadMcpToolsConfig,
  mapToolArgs,
  parseMcpToolsConfig,
  resolveCallTimeoutMs,
  resolveToolMappings,
} from "../src/tools/mcp-config.js";
import type { ToolName } from "../src/tools/types.js";

const envNames: Record<ToolName, string> = {
  get_ticket: "get_issue",
  search_tickets: "search_issues",
  list_failed_pipelines: "list_failed_pipelines",
};

const atlassian = {
  tools: {
    get_ticket: { name: "jira_get_issue", args: { issue_key: { arg: "key" } } },
    search_tickets: {
      name: "jira_search",
      args: { jql: { template: 'text ~ "{query}" ORDER BY updated DESC' }, limit: { value: 10 } },
    },
  },
};

describe("MCP tool mapping config", () => {
  it("keeps the MCP_TOOL_* names and identity arguments when there is no config file", () => {
    const mappings = resolveToolMappings(envNames, undefined);
    expect(mappings.get_ticket).toEqual({ name: "get_issue" });
    expect(mapToolArgs(mappings.get_ticket, { key: "DEMO-101" })).toEqual({ key: "DEMO-101" });
  });

  it("renames arguments, adds fixed literals and fills templates", () => {
    const mappings = resolveToolMappings(envNames, parseMcpToolsConfig(atlassian));
    expect(mappings.get_ticket.name).toBe("jira_get_issue");
    expect(mapToolArgs(mappings.get_ticket, { key: "DEMO-101" })).toEqual({ issue_key: "DEMO-101" });
    expect(mapToolArgs(mappings.search_tickets, { query: "cdn" })).toEqual({ jql: 'text ~ "cdn" ORDER BY updated DESC', limit: 10 });
    // Tools left out of the file fall back to the env name and identity arguments.
    expect(mappings.list_failed_pipelines).toEqual({ name: "list_failed_pipelines" });
  });

  it("escapes backslashes and double quotes substituted into a template", () => {
    const mappings = resolveToolMappings(envNames, parseMcpToolsConfig(atlassian));
    const { jql } = mapToolArgs(mappings.search_tickets, { query: 'a" OR project = X \\' });
    expect(jql).toBe('text ~ "a\\" OR project = X \\\\" ORDER BY updated DESC');
  });

  it("rejects unknown local tools, unknown argument references and malformed specs with a readable error", () => {
    expect(() => parseMcpToolsConfig({ tools: { delete_ticket: { name: "jira_delete" } } })).toThrow(/delete_ticket/);
    expect(() => parseMcpToolsConfig({ tools: { get_ticket: { name: "x", args: { id: { arg: "ticket" } } } } })).toThrow(/"ticket"/);
    expect(() => parseMcpToolsConfig({ tools: { search_tickets: { name: "x", args: { jql: { template: "{nope}" } } } } })).toThrow(/"nope"/);
    expect(() => parseMcpToolsConfig({ tools: { get_ticket: { name: "", args: {} } } })).toThrow(/MCP tools config/);
    expect(() => parseMcpToolsConfig({ tools: { get_ticket: { name: "x", args: { id: { value: { nested: 1 } } } } } })).toThrow(/MCP tools config/);
  });

  it("validates the call timeout", () => {
    expect(resolveCallTimeoutMs(undefined)).toBe(20000);
    expect(resolveCallTimeoutMs("1500")).toBe(1500);
    expect(() => resolveCallTimeoutMs("0")).toThrow(/MCP_CALL_TIMEOUT_MS/);
    expect(() => resolveCallTimeoutMs("abc")).toThrow(/MCP_CALL_TIMEOUT_MS/);
  });

  describe("loading from disk", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "mcp-config-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("accepts the committed example", async () => {
      const example = await loadMcpToolsConfig(join(process.cwd(), "config/mcp-tools.example.json"));
      expect(Object.keys(example?.tools ?? {})).toEqual(["get_ticket", "search_tickets", "list_failed_pipelines"]);
    });

    it("returns undefined when the file is absent and throws on invalid JSON", async () => {
      expect(await loadMcpToolsConfig(join(dir, "missing.json"))).toBeUndefined();
      await writeFile(join(dir, "bad.json"), "{ not json");
      await expect(loadMcpToolsConfig(join(dir, "bad.json"))).rejects.toThrow(/not valid JSON/);
      await writeFile(join(dir, "ok.json"), JSON.stringify(atlassian));
      expect((await loadMcpToolsConfig(join(dir, "ok.json")))?.tools.get_ticket?.name).toBe("jira_get_issue");
    });
  });
});
