import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export interface Embedder {
  readonly model: string;
  embedQuery(text: string): Promise<number[]>;
  embedPassages(texts: string[]): Promise<number[][]>;
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
    return this.embed(texts.map((t) => `passage: ${t}`));
  }

  private async embed(texts: string[]): Promise<number[][]> {
    this.extractor ??= this.load();
    const extractor = await this.extractor;
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist() as number[][];
  }

  private async load(): Promise<FeatureExtractionPipeline> {
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
