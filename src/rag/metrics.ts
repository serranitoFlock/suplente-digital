/**
 * Retrieval-only metrics (computed before generation). Inputs are the source files of the ranked
 * chunks, best first; relevance is judged per document (`expectedSources` in evals/questions.json).
 */

/** Share of expected documents that appear among the top `k` chunks. */
export function recallAtK(rankedSources: string[], expected: string[], k: number): number {
  if (expected.length === 0) throw new Error("recallAtK needs at least one expected source.");
  const top = new Set(rankedSources.slice(0, k));
  return expected.filter((source) => top.has(source)).length / expected.length;
}

/** 1 / rank of the first chunk from an expected document; 0 when none is retrieved. Averaged, this is MRR. */
export function reciprocalRank(rankedSources: string[], expected: string[]): number {
  const rank = rankedSources.findIndex((source) => expected.includes(source));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

export function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((total, v) => total + v, 0) / values.length : undefined;
}
