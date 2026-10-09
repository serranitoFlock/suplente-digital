import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export interface Embedder {
  readonly model: string;
  embedQuery(text: string): Promise<number[]>;
  embedPassages(texts: string[]): Promise<number[][]>;
}

const PASSAGE_BATCH_SIZE = 16;

/** Splits a list into consecutive batches of at most `size` items. */
export function inBatches<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("Batch size must be at least 1.");
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Local multilingual embeddings (no API key). E5 models expect "query: " and
 * "passage: " prefixes; vectors are mean-pooled and L2-normalized.
 */
export class LocalE5Embedder implements Embedder {
  private extractor?: Promise<FeatureExtractionPipeline>;

  constructor(
    readonly model: string,
    private readonly cacheDir: string,
  ) {}

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([`query: ${text}`]);
    return vector!;
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    // Small batches: one batch pads every text to the longest one, which made a few hundred
    // Engram notes take minutes and gigabytes of memory.
    const vectors: number[][] = [];
    for (const batch of inBatches(texts, PASSAGE_BATCH_SIZE)) vectors.push(...(await this.embed(batch.map((t) => `passage: ${t}`))));
    return vectors;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    this.extractor ??= this.load();
    const extractor = await this.extractor;
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist() as number[][];
  }

  private async load(): Promise<FeatureExtractionPipeline> {
    // Imported lazily: loading transformers pulls in the onnxruntime-node native binary, which unit
    // tests and CI never need (they use a fake embedder).
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = this.cacheDir;
    return (await pipeline("feature-extraction", this.model)) as FeatureExtractionPipeline;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}
