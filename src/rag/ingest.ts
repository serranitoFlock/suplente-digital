import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { chunkMarkdown } from "./chunk.js";
import { LocalE5Embedder, type Embedder } from "./embeddings.js";
import type { VectorIndex } from "./retriever.js";

export interface SourceDoc {
  source: string;
  markdown: string;
}

export async function loadKnowledge(dir: string): Promise<SourceDoc[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  return Promise.all(files.map(async (source) => ({ source, markdown: await readFile(join(dir, source), "utf8") })));
}

export async function buildIndexFromDocs(docs: SourceDoc[], embedder: Embedder): Promise<VectorIndex> {
  const chunks = docs.flatMap((doc) => chunkMarkdown(doc.source, doc.markdown));
  // Embed heading + text so section titles contribute to retrieval.
  const vectors = await embedder.embedPassages(chunks.map((c) => `${c.heading}\n${c.text}`));
  return {
    model: embedder.model,
    createdAt: new Date().toISOString(),
    chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i]! })),
  };
}

async function main(): Promise<void> {
  const docs = await loadKnowledge(config.knowledgeDir);
  console.log(`Indexing ${docs.length} documents with ${config.embeddingModel} (first run downloads the model)...`);
  const index = await buildIndexFromDocs(docs, new LocalE5Embedder(config.embeddingModel, config.transformersCacheDir));
  await mkdir(dirname(config.indexPath), { recursive: true });
  await writeFile(config.indexPath, JSON.stringify(index));
  console.log(`Wrote ${index.chunks.length} chunks to ${config.indexPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
