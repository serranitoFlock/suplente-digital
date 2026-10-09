import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyJsonlLog, localDateStamp, summarizeToolResult, type ConversationLogEntry, type NewLogEntry } from "../src/logging/conversation-log.js";

const entry = (requestId: number, extra: Partial<NewLogEntry> = {}): NewLogEntry => ({
  event: "request",
  requestId,
  requester: "local",
  question: `¿Q${requestId}?`,
  route: "question",
  outcome: "answered",
  answer: "Con changesets [1].\n\nFuentes:\n[1] a.md › A",
  citedSources: ["a.md › A"],
  toolCalls: [],
  latencyMs: 12,
  ...extra,
});

const readLines = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ConversationLogEntry);

describe("DailyJsonlLog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "convlog-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names files by local date and rolls over at midnight", async () => {
    let now = new Date(2026, 9, 9, 23, 59, 30);
    const log = new DailyJsonlLog(join(dir, "logs"), () => now);
    await log.append(entry(1));
    now = new Date(2026, 9, 10, 0, 0, 5);
    await log.append(entry(2));

    expect((await readdir(join(dir, "logs"))).sort()).toEqual(["2026-10-09.jsonl", "2026-10-10.jsonl"]);
    const [first] = await readLines(join(dir, "logs", "2026-10-09.jsonl"));
    expect(first).toMatchObject({ requestId: 1, timestamp: new Date(2026, 9, 9, 23, 59, 30).toISOString(), answer: expect.stringContaining("Fuentes:") });
    expect(log.todayPath()).toBe(join(dir, "logs", "2026-10-10.jsonl"));
    expect(await log.countToday()).toBe(1);
  });

  it("keeps every line when appends run concurrently", async () => {
    const log = new DailyJsonlLog(dir, () => new Date(2026, 9, 9, 12));
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(entry(i + 1))));
    const lines = await readLines(log.todayPath());
    expect(lines.map((l) => l.requestId).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("counts 0 when today's file does not exist", async () => {
    expect(await new DailyJsonlLog(join(dir, "nada")).countToday()).toBe(0);
  });

  it("formats local dates and summarizes tool results", () => {
    expect(localDateStamp(new Date(2026, 0, 5, 1, 2))).toBe("2026-01-05");
    expect(summarizeToolResult([{ pipeline: "acme-card-elements" }, { pipeline: "acme-shell" }])).toMatch(/^2 elementos: \[\{"pipeline":"acme-card-elements"/);
    expect(summarizeToolResult({ key: "DEMO-101" })).toBe('{"key":"DEMO-101"}');
    expect(summarizeToolResult("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});
