import type { Chunk } from "./chunk.js";
import type { ScoredChunk } from "./retriever.js";

/**
 * Source-balanced context selection (see docs/spec.md, "Retrieval").
 *
 * E5 scores are compressed (relevant chunks often land within ~0.01 of each other), so ranking alone
 * lets ~1k terse Engram notes crowd the curated docs out of a top-k context. Instead, the best
 * candidates are split by source and each source gets its own slots: curated docs (`knowledge/*.md`)
 * first, then Engram notes (real and sample).
 */
export interface ContextOptions {
  /** Cosine cut-off: chunks below it are never candidates. */
  minScore: number;
  /** Candidates considered after the `minScore` cut, best first (default 20). */
  candidates?: number;
  /** Maximum chunks from curated docs (default 4). */
  docSlots?: number;
  /** Maximum chunks from Engram notes (default 2). They also get the doc slots when no curated chunk passes `minScore`. */
  engramSlots?: number;
}

export const DEFAULT_CONTEXT = { candidates: 20, docSlots: 4, engramSlots: 2 } as const;

/** Engram notes are indexed under `engram:#<id> › <project> › <title>`; everything else is a curated doc. */
export function isEngramSource(source: string): boolean {
  return source.startsWith("engram:");
}

/** Position of a chunk inside its document (chunk ids are `<source>#<n>`); 0 when the id has no position. */
export function chunkPosition(chunk: Pick<Chunk, "id">): number {
  const match = /#(\d+)$/.exec(chunk.id);
  return match ? Number(match[1]) : 0;
}

/**
 * Picks the chunks passed to the model from `ranked` (every chunk of the index, scored, best first):
 * up to `docSlots` curated chunks, then up to `engramSlots` Engram chunks, each group best first.
 * Unused slots of one source are not given to the other, except that Engram may fill the doc slots
 * when no curated chunk passes `minScore` (an Engram-only answer still gets a full context).
 */
export function selectContext(ranked: ScoredChunk[], options: ContextOptions): ScoredChunk[] {
  const { minScore, candidates = DEFAULT_CONTEXT.candidates, docSlots = DEFAULT_CONTEXT.docSlots, engramSlots = DEFAULT_CONTEXT.engramSlots } = options;
  const pool = ranked.filter((chunk) => chunk.score >= minScore).slice(0, candidates);
  const curated = pool.filter((chunk) => !isEngramSource(chunk.source));
  const engram = pool.filter((chunk) => isEngramSource(chunk.source));
  if (curated.length === 0) return engram.slice(0, docSlots + engramSlots);
  return [...curated.slice(0, docSlots), ...engram.slice(0, engramSlots)];
}

/** Non-negative integer from an environment variable (`RETRIEVAL_DOC_SLOTS`, `RETRIEVAL_ENGRAM_SLOTS`). */
export function resolveSlotCount(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer, got "${raw}".`);
  return Number(value);
}
