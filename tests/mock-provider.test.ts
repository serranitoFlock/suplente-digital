import { describe, expect, it } from "vitest";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import { parseToolCall } from "../src/tools/types.js";

describe("MockToolProvider", () => {
  const provider = new MockToolProvider(new Date("2026-10-09T12:00:00Z"));

  it("returns a ticket by key (case-insensitive)", async () => {
    const result = JSON.parse(await provider.call({ tool: "get_ticket", args: { key: "demo-101" } }));
    expect(result.key).toBe("DEMO-101");
    expect(result.status).toBeTruthy();
  });

  it("reports unknown tickets without throwing", async () => {
    const result = JSON.parse(await provider.call({ tool: "get_ticket", args: { key: "DEMO-999" } }));
    expect(result.error).toMatch(/DEMO-999/);
  });

  it("searches tickets by text", async () => {
    const result = JSON.parse(await provider.call({ tool: "search_tickets", args: { query: "cdn" } }));
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((t: { summary: string }) => /cdn/i.test(t.summary))).toBe(true);
  });

  it("lists failed pipelines within the time window", async () => {
    const week = JSON.parse(await provider.call({ tool: "list_failed_pipelines", args: { sinceDays: 7 } }));
    const all = JSON.parse(await provider.call({ tool: "list_failed_pipelines", args: { sinceDays: 60 } }));
    expect(week.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(week.length);
  });
});

describe("parseToolCall", () => {
  it("validates tool name and arguments", () => {
    expect(parseToolCall('{"tool":"get_ticket","args":{"key":"DEMO-101"}}')).toEqual({
      tool: "get_ticket",
      args: { key: "DEMO-101" },
    });
    expect(parseToolCall('{"tool":"list_failed_pipelines","args":{}}')).toEqual({
      tool: "list_failed_pipelines",
      args: { sinceDays: 7 },
    });
  });

  it("returns null for unknown tools, invalid args or none", () => {
    expect(parseToolCall('{"tool":"delete_ticket","args":{"key":"DEMO-1"}}')).toBeNull();
    expect(parseToolCall('{"tool":"get_ticket","args":{}}')).toBeNull();
    expect(parseToolCall('{"tool":"none"}')).toBeNull();
    expect(parseToolCall("garbage")).toBeNull();
  });
});
