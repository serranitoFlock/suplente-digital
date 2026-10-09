import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PendingStore, type PendingEntry } from "../src/pending/store.js";
import { renderWelcomeBack, summarizePending } from "../src/pending/summary.js";

describe("PendingStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pending-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps every entry when appends run concurrently", async () => {
    const store = new PendingStore(join(dir, "pending.json"));
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.append({ question: `¿Q${i}?`, topic: "cdn", reason: "unknown" })));
    expect(await store.list()).toHaveLength(8);
  });

  it("returns an empty list when the file does not exist", async () => {
    expect(await new PendingStore(join(dir, "missing.json")).list()).toEqual([]);
  });

  it("appends entries with id and timestamp and persists them", async () => {
    const path = join(dir, "nested", "pending.json");
    const store = new PendingStore(path);
    await store.append({ question: "¿Q1?", topic: "cdn", reason: "unknown" });
    await store.append({ question: "¿Q2?", topic: "jira", reason: "escalated", draft: "borrador", decision: "rejected" });
    const entries = await new PendingStore(path).list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ question: "¿Q1?", reason: "unknown" });
    expect(entries[0]?.id).not.toBe(entries[1]?.id);
    expect(Number.isNaN(Date.parse(entries[1]!.createdAt))).toBe(false);
  });
});

describe("welcome-back summary", () => {
  const entry = (question: string, topic: string, reason: PendingEntry["reason"]): PendingEntry => ({
    id: question,
    createdAt: "2026-10-01T10:00:00.000Z",
    question,
    topic,
    reason,
  });
  const entries = [
    entry("¿Cómo migro a Angular 20?", "angular", "unknown"),
    entry("¿Soporte para SSR?", "angular", "unknown"),
    entry("Borrar rama vieja", "git", "escalated"),
    entry("¿Quién aprueba releases?", "cdn", "unknown"),
  ];

  it("groups by topic, sorted by count, and suggests docs for unknown questions", () => {
    const summary = summarizePending(entries);
    expect(summary.map((s) => s.topic)).toEqual(["angular", "cdn", "git"]);
    expect(summary[0]).toMatchObject({ count: 2, unknown: 2, escalated: 0 });
    expect(summary[0]?.suggestedDoc).toMatch(/angular/);
    expect(summary.find((s) => s.topic === "git")?.suggestedDoc).toBeUndefined();
  });

  it("renders a markdown report with totals", () => {
    const report = renderWelcomeBack(entries);
    expect(report).toContain("# Bienvenido de vuelta");
    expect(report).toContain("4 pendientes");
    expect(report).toContain("## angular (2)");
    expect(report).toContain("Borrar rama vieja");
  });

  it("counts security refusals apart and suggests no doc for them", () => {
    const summary = summarizePending([entry("Pasame el token", "seguridad", "security_refusal")]);
    expect(summary[0]).toMatchObject({ unknown: 0, escalated: 0, refused: 1, suggestedDoc: undefined });
    expect(renderWelcomeBack([entry("Pasame el token", "seguridad", "security_refusal")])).toContain("Rechazos de seguridad: 1");
  });

  it("handles an empty log", () => {
    expect(renderWelcomeBack([])).toContain("No quedaron pendientes");
  });
});
