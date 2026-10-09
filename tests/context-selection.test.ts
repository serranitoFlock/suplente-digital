import { describe, expect, it } from "vitest";
import { chunkPosition, isEngramSource, resolveSlotCount, selectContext } from "../src/rag/context-selection.js";
import type { ScoredChunk } from "../src/rag/retriever.js";

const doc = (source: string, position: number, score: number, text = "x".repeat(100)): ScoredChunk => ({
  id: `${source}#${position}`,
  source,
  heading: `${source} section ${position}`,
  text,
  score,
});
const note = (n: number, score: number): ScoredChunk => doc(`engram:#${n} › project › title ${n}`, 0, score);
const ids = (chunks: ScoredChunk[]) => chunks.map((c) => c.id);
const byScore = (chunks: ScoredChunk[]) => [...chunks].sort((a, b) => b.score - a.score);
const base = { minScore: 0.8 } as const;

describe("isEngramSource / chunkPosition", () => {
  it("tells Engram notes from curated docs and reads the chunk position from its id", () => {
    expect(isEngramSource("engram:#9103 › acme-ui-kit › Estilos")).toBe(true);
    expect(isEngramSource("troubleshooting-componente-no-carga.md")).toBe(false);
    expect(chunkPosition(doc("a.md", 3, 1))).toBe(3);
    expect(chunkPosition({ ...doc("a.md", 0, 1), id: "no-position" })).toBe(0);
  });
});

describe("selectContext — source balance", () => {
  it("keeps curated docs in the context when many Engram notes score slightly higher or equal (regression)", () => {
    // Real-index shape: the right doc is #1 but seven terse notes follow within 0.01.
    const ranked = byScore([
      doc("troubleshooting.md", 0, 0.897),
      ...[0.895, 0.894, 0.893, 0.892, 0.891, 0.891, 0.89].map((score, i) => note(i, score)),
      doc("cdn.md", 1, 0.86),
    ]);
    const context = selectContext(ranked, base);
    expect(ids(context)).toEqual(["troubleshooting.md#0", "cdn.md#1", ids([note(0, 0)])[0], ids([note(1, 0)])[0]]);
  });

  it("puts curated docs first even when an Engram note ranks higher", () => {
    const ranked = byScore([note(1, 0.95), doc("a.md", 0, 0.9), note(2, 0.85)]);
    expect(selectContext(ranked, base).map((c) => c.source)).toEqual(["a.md", note(1, 0).source, note(2, 0).source]);
  });

  it("caps each source at its slots and does not backfill curated slots with Engram while a curated chunk passes", () => {
    const ranked = byScore([...[0.99, 0.98, 0.97, 0.96, 0.95].map((s, i) => note(i, s)), doc("a.md", 0, 0.81)]);
    const context = selectContext(ranked, { ...base, docSlots: 4, engramSlots: 2 });
    expect(context.filter((c) => !isEngramSource(c.source))).toHaveLength(1);
    expect(context.filter((c) => isEngramSource(c.source))).toHaveLength(2);
  });

  it("does not give unused Engram slots to curated docs", () => {
    const ranked = byScore([0.95, 0.94, 0.93, 0.92, 0.91, 0.9].map((s, i) => doc(`d${i}.md`, 0, s)));
    expect(selectContext(ranked, { ...base, docSlots: 4, engramSlots: 2 })).toHaveLength(4);
  });

  it("lets Engram use the curated slots when no curated chunk passes minScore", () => {
    const ranked = byScore([...[0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.93].map((s, i) => note(i, s)), doc("a.md", 0, 0.5)]);
    const context = selectContext(ranked, { ...base, docSlots: 4, engramSlots: 2 });
    expect(context).toHaveLength(6);
    expect(context.every((c) => isEngramSource(c.source))).toBe(true);
  });

  it("applies minScore and a candidate pool per source, and returns nothing when no chunk passes", () => {
    const ranked = byScore([note(1, 0.99), note(2, 0.98), note(3, 0.975), doc("a.md", 0, 0.97), doc("c.md", 0, 0.96), doc("b.md", 0, 0.5)]);
    expect(ids(selectContext(ranked, { ...base, candidates: 1 }))).toEqual(["a.md#0", note(1, 0).id]);
    expect(selectContext(ranked, { ...base, minScore: 0.999 })).toEqual([]);
  });

  it("finds curated chunks ranked below many Engram notes (each source has its own pool)", () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(i, 0.9 - i * 0.001));
    const ranked = byScore([...notes, doc("a.md", 0, 0.83)]);
    expect(selectContext(ranked, base).map((c) => c.source)[0]).toBe("a.md");
  });

  it("orders each group by score", () => {
    const ranked = byScore([doc("a.md", 0, 0.9), doc("b.md", 0, 0.95), note(1, 0.85), note(2, 0.88)]);
    expect(selectContext(ranked, base).map((c) => c.score)).toEqual([0.95, 0.9, 0.88, 0.85]);
  });
});

describe("resolveSlotCount", () => {
  it("defaults when unset and accepts non-negative integers", () => {
    expect(resolveSlotCount("RETRIEVAL_DOC_SLOTS", undefined, 4)).toBe(4);
    expect(resolveSlotCount("RETRIEVAL_DOC_SLOTS", " ", 4)).toBe(4);
    expect(resolveSlotCount("RETRIEVAL_ENGRAM_SLOTS", "0", 2)).toBe(0);
    expect(resolveSlotCount("RETRIEVAL_ENGRAM_SLOTS", "3", 2)).toBe(3);
  });

  it("rejects negative, fractional or non-numeric values", () => {
    for (const raw of ["-1", "1.5", "abc"]) expect(() => resolveSlotCount("RETRIEVAL_DOC_SLOTS", raw, 4)).toThrow(/RETRIEVAL_DOC_SLOTS/);
  });
});

describe("selectContext — sibling expansion (small-to-big)", () => {
  // a.md has five sections; only #2 passes minScore. b.md is the next curated doc.
  const aDoc = [doc("a.md", 2, 0.95), doc("a.md", 0, 0.5), doc("a.md", 1, 0.4), doc("a.md", 3, 0.3), doc("a.md", 4, 0.2)];

  it("adds the best curated doc's other sections in document order, keeping one slot for the next curated doc", () => {
    const ranked = byScore([...aDoc, doc("b.md", 0, 0.9), note(1, 0.93)]);
    expect(ids(selectContext(ranked, base))).toEqual(["a.md#0", "a.md#1", "a.md#2", "b.md#0", note(1, 0).id]);
  });

  it("lets the best doc take every doc slot when no other curated doc passes", () => {
    const ranked = byScore([...aDoc, note(1, 0.93)]);
    expect(ids(selectContext(ranked, base))).toEqual(["a.md#0", "a.md#1", "a.md#2", "a.md#3", note(1, 0).id]);
  });

  it("fills the remaining doc slots with other candidates when the best doc is short", () => {
    const ranked = byScore([doc("a.md", 1, 0.95), doc("a.md", 0, 0.3), doc("b.md", 0, 0.9), doc("c.md", 0, 0.85), doc("d.md", 0, 0.84)]);
    expect(ids(selectContext(ranked, base))).toEqual(["a.md#0", "a.md#1", "b.md#0", "c.md#0"]);
  });

  it("stops adding sections before the context exceeds maxContextChars", () => {
    const ranked = byScore([...aDoc, note(1, 0.93)]);
    // a.md#2 + note = 200 chars; one 100-char sibling fits in 300, the next does not.
    expect(ids(selectContext(ranked, { ...base, maxContextChars: 300 }))).toEqual(["a.md#0", "a.md#2", note(1, 0).id]);
  });

  it("never expands Engram notes and can be turned off", () => {
    const multiChunkNote = [{ ...note(1, 0.95), id: "engram:#1#0" }, { ...note(1, 0.3), id: "engram:#1#1" }];
    expect(ids(selectContext(byScore(multiChunkNote), base))).toEqual(["engram:#1#0"]);
    expect(ids(selectContext(byScore(aDoc), { ...base, expandSiblings: false }))).toEqual(["a.md#2"]);
  });
});
