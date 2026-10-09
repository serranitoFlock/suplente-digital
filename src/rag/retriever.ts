import { readFile } from "node:fs/promises";
import type { Chunk } from "./chunk.js";
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

export interface RetrievalOptions {
  topK: number;
  minScore: number;
}

export function rankChunks(query: number[], chunks: IndexedChunk[], { topK, minScore }: RetrievalOptions): ScoredChunk[] {
  return chunks
    .map(({ embedding, ...chunk }) => ({ ...chunk, score: cosineSimilarity(query, embedding) }))
    .filter((chunk) => chunk.score >= minScore)
    .sort((a, b) => b.score - a.score)
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

  async retrieve(query: string): Promise<ScoredChunk[]> {
    return rankChunks(await this.embedder.embedQuery(query), this.index.chunks, this.options);
  }
}
