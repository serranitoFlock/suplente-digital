import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { chunkMarkdown, stripHtmlComments, type Chunk } from "./chunk.js";
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

/** Document title: the first H1 (HTML comments ignored); empty when the doc has none. */
export function documentTitle(markdown: string): string {
  const h1 = stripHtmlComments(markdown)
    .split(/\r?\n/)
    .find((line) => /^#\s+/.test(line));
  return h1?.replace(/^#\s+/, "").trim() ?? "";
}

/**
 * Text embedded for a chunk: a short "contextual" header (document title, then the heading path)
 * before the chunk text, so a section like "Pasos" still says which document it belongs to.
 * A cheap, LLM-free take on Anthropic's Contextual Retrieval
 * (https://www.anthropic.com/news/contextual-retrieval). Measured with `npm run eval:retrieval`:
 * recall@k and MRR unchanged vs. heading + text, slightly lower scores for unanswerable questions;
 * adding the document's intro paragraph made recall@4 worse, so it is not included.
 */
export function contextualPassage(chunk: Chunk, title: string): string {
  return [`Documento: ${title || chunk.source}`, chunk.heading && `Sección: ${chunk.heading}`, chunk.text].filter(Boolean).join("\n");
}

export async function buildIndexFromDocs(docs: SourceDoc[], embedder: Embedder): Promise<VectorIndex> {
  const prepared = docs.flatMap((doc) => {
    const title = documentTitle(doc.markdown);
    return chunkMarkdown(doc.source, doc.markdown).map((chunk) => ({ chunk, passage: contextualPassage(chunk, title) }));
  });
  const chunks = prepared.map((p) => p.chunk);
  const vectors = await embedder.embedPassages(prepared.map((p) => p.passage));
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
