import type { Source } from "./state.js";

/** A retrieved source the reply actually cites, with its original `[n]` number. */
export interface CitedSource extends Source {
  n: number;
}

/** `[1]`, `[2, 3]`, `[1-2]`: citation markers as the answer prompt asks the model to write them. */
export const CITATION_MARKER = /\[(\d+(?:\s*[,–-]\s*\d+)*)\]/gu;

/** Numbers cited in the reply, in order of first appearance. */
export function citedNumbers(text: string): number[] {
  const numbers = [...text.matchAll(CITATION_MARKER)].flatMap((match) => match[1]!.split(/\s*[,–-]\s*/u).map(Number));
  return [...new Set(numbers)];
}

/** Keeps only the retrieved sources the reply cites (unknown numbers are ignored), sorted by number. */
export function selectCitedSources(sources: Source[], reply: string): CitedSource[] {
  const cited = new Set(citedNumbers(reply));
  return sources.flatMap((source, i) => (cited.has(i + 1) ? [{ ...source, n: i + 1 }] : []));
}

/** "file › heading", or just the source when the chunk has no heading (e.g. an Engram note, whose label already holds its title). */
export function sourceLabel({ source, heading }: Pick<Source, "source" | "heading">): string {
  return heading ? `${source} › ${heading}` : source;
}

export function formatCitedSources(sources: CitedSource[]): string {
  return sources.map((s) => `[${s.n}] ${sourceLabel(s)}`).join("\n");
}
