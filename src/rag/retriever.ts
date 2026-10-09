import { readFile } from "node:fs/promises";
import type { Chunk } from "./chunk.js";
import { selectContext, type ContextOptions } from "./context-selection.js";
import { cosineSimilarity, type Embedder } from "./embeddings.js";

export interface IndexedChunk extends Chunk {
  embedding: number[];
}

export interface VectorIndex {
  model: string;
  createdAt: string;
  /** Chunk counts per source origin (`knowledge`, `engram-sample`, `engram-real`); absent in older indexes. */
  composition?: Partial<Record<string, number>>;
  chunks: IndexedChunk[];
}

export interface ScoredChunk extends Chunk {
  score: number;
}

/** How the answer context is picked from the ranking (source slots, `minScore`); see `selectContext`. */
export type RetrievalOptions = ContextOptions;

/** Every chunk scored against the query, best first (no cut-off). */
export function scoreChunks(query: number[], chunks: IndexedChunk[]): ScoredChunk[] {
  return chunks.map(({ embedding, ...chunk }) => ({ ...chunk, score: cosineSimilarity(query, embedding) })).sort((a, b) => b.score - a.score);
}

/** Plain top-k ranking above `minScore`, regardless of source. */
export function rankChunks(query: number[], chunks: IndexedChunk[], { topK, minScore }: { topK: number; minScore: number }): ScoredChunk[] {
  return scoreChunks(query, chunks)
    .filter((chunk) => chunk.score >= minScore)
    .slice(0, topK);
}

export class Retriever {
  constructor(
    private readonly index: VectorIndex,
    private readonly embedder: Embedder,
    private readonly options: RetrievalOptions,
  ) {
    if (index.model !== embedder.model) {
      throw new Error(`Index built with "${index.model}" but embedder is "${embedder.model}". Run \`npm run ingest\`.`);
    }
  }

  static async load(path: string, embedder: Embedder, options: RetrievalOptions): Promise<Retriever> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new Error(`Index not found at ${path}. Run \`npm run ingest\` first.`);
    }
    return new Retriever(JSON.parse(raw) as VectorIndex, embedder, options);
  }

  /** The whole index ranked for `query`, best first (retrieval metrics). */
  async rank(query: string): Promise<ScoredChunk[]> {
    return scoreChunks(await this.embedder.embedQuery(query), this.index.chunks);
  }

  /** The context passed to the model: source-balanced chunks for `query` (curated docs first). */
  async retrieve(query: string): Promise<ScoredChunk[]> {
    return selectContext(await this.rank(query), this.options);
  }
}
