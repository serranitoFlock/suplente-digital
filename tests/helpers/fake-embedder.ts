import type { Embedder } from "../../src/rag/embeddings.js";

const DIMENSIONS = 64;

/** Deterministic bag-of-words embedder: hashes each token into a fixed-size vector. */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-bow";

  async embedQuery(text: string): Promise<number[]> {
    return embed(text);
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map(embed);
  }
}

function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const slot = hash(token) % DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

function hash(token: string): number {
  let h = 0;
  for (const char of token) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h;
}
