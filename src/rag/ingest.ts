import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { chunkMarkdown, stripHtmlComments, type Chunk } from "./chunk.js";
import { engramSourceDocs, filterObservations, parseEngramExport, type DropReason } from "./engram.js";
import { loadEngramSourcesConfig } from "./engram-config.js";
import { LocalE5Embedder, type Embedder } from "./embeddings.js";
import { GLOSSARY_FILE, parseGlossary, type QueryRewrite } from "./glossary.js";
import type { VectorIndex } from "./retriever.js";

export type SourceOrigin = "knowledge" | "engram-sample" | "engram-real";

export interface SourceDoc {
  source: string;
  markdown: string;
  /** Contextual header title; defaults to the document's first H1. */
  title?: string;
  /** Where the doc came from (default `knowledge`); only used for the index composition counts. */
  origin?: SourceOrigin;
}

export async function loadKnowledge(dir: string): Promise<SourceDoc[]> {
  // The glossary rewrites queries (see glossary.ts); indexed as a doc it would compete for the doc slots.
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== GLOSSARY_FILE).sort();
  return Promise.all(files.map(async (source) => ({ source, markdown: await readFile(join(dir, source), "utf8"), origin: "knowledge" as const })));
}

export interface EngramLoadOptions {
  samplePath: string;
  includeSample: boolean;
  includeReal: boolean;
  configPath: string;
  exportDir: string;
}

/** Per-source counts (never contents): raw observations, kept after filters, and why the rest was dropped. */
export interface EngramSourceReport {
  name: string;
  origin: "engram-sample" | "engram-real";
  raw: number;
  kept: number;
  dropped: Record<DropReason, number>;
}

/**
 * Engram docs for the index: the fictional sample (public demo / evals) and the real exports of the
 * projects in the local allowlist. Real exports are read only for allowlisted projects, and their
 * observations must also belong to that project; without the local config they are skipped.
 */
export async function loadEngramDocs(options: EngramLoadOptions): Promise<{ docs: SourceDoc[]; reports: EngramSourceReport[]; notes: string[] }> {
  const docs: SourceDoc[] = [];
  const reports: EngramSourceReport[] = [];
  const notes: string[] = [];

  if (options.includeSample) {
    const data = parseEngramExport(JSON.parse(await readFile(options.samplePath, "utf8")), options.samplePath);
    const { kept, dropped } = filterObservations(data);
    docs.push(...engramSourceDocs(kept).map((doc) => ({ ...doc, origin: "engram-sample" as const })));
    reports.push({ name: "sample", origin: "engram-sample", raw: data.observations.length, kept: kept.length, dropped });
  }

  if (options.includeReal) {
    let sources;
    try {
      sources = await loadEngramSourcesConfig(options.configPath);
    } catch (error) {
      notes.push(`Real Engram exports skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const project of sources?.projects ?? []) {
      let text: string;
      try {
        text = await readFile(join(options.exportDir, `${project}.json`), "utf8");
      } catch {
        notes.push(`No export for "${project}" in ${options.exportDir} (run \`npm run engram:export\`).`);
        continue;
      }
      const data = parseEngramExport(JSON.parse(text), `${project}.json`);
      const { kept, dropped } = filterObservations(data, { types: sources!.types, projects: [project] });
      docs.push(...engramSourceDocs(kept).map((doc) => ({ ...doc, origin: "engram-real" as const })));
      reports.push({ name: project, origin: "engram-real", raw: data.observations.length, kept: kept.length, dropped });
    }
  }
  return { docs, reports, notes };
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

/** The glossary's query rewrites; none when `knowledge/glosario.md` is missing. */
export async function loadGlossary(dir: string): Promise<QueryRewrite[]> {
  try {
    return parseGlossary(await readFile(join(dir, GLOSSARY_FILE), "utf8"));
  } catch {
    return [];
  }
}

export async function buildIndexFromDocs(docs: SourceDoc[], embedder: Embedder, queryRewrites: QueryRewrite[] = []): Promise<VectorIndex> {
  const prepared = docs.flatMap((doc) => {
    const title = doc.title ?? documentTitle(doc.markdown);
    return chunkMarkdown(doc.source, doc.markdown).map((chunk) => ({ chunk, origin: doc.origin ?? "knowledge", passage: contextualPassage(chunk, title) }));
  });
  const chunks = prepared.map((p) => p.chunk);
  const vectors = await embedder.embedPassages(prepared.map((p) => p.passage));
  const composition: Partial<Record<SourceOrigin, number>> = {};
  for (const { origin } of prepared) composition[origin] = (composition[origin] ?? 0) + 1;
  return {
    model: embedder.model,
    createdAt: new Date().toISOString(),
    composition,
    ...(queryRewrites.length > 0 ? { queryRewrites } : {}),
    chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i]! })),
  };
}

async function main(): Promise<void> {
  const knowledge = await loadKnowledge(config.knowledgeDir);
  const engram = await loadEngramDocs(config.engram);
  for (const note of engram.notes) console.log(note);
  for (const r of engram.reports) {
    const dropped = Object.entries(r.dropped).filter(([, n]) => n > 0).map(([reason, n]) => `${reason} ${n}`).join(", ");
    console.log(`Engram ${r.origin === "engram-sample" ? "sample" : `project ${r.name}`}: ${r.raw} observations → ${r.kept} kept${dropped ? ` (dropped: ${dropped})` : ""}`);
  }
  const docs = [...knowledge, ...engram.docs];
  console.log(`Indexing ${knowledge.length} knowledge documents + ${engram.docs.length} Engram notes with ${config.embeddingModel} (first run downloads the model)...`);
  const queryRewrites = await loadGlossary(config.knowledgeDir);
  console.log(`Glossary: ${queryRewrites.length} query rewrite(s) from ${GLOSSARY_FILE}`);
  const index = await buildIndexFromDocs(docs, new LocalE5Embedder(config.embeddingModel, config.transformersCacheDir), queryRewrites);
  await mkdir(dirname(config.indexPath), { recursive: true });
  await writeFile(config.indexPath, JSON.stringify(index));
  console.log(`Wrote ${index.chunks.length} chunks to ${config.indexPath} (${Object.entries(index.composition ?? {}).map(([origin, n]) => `${origin} ${n}`).join(", ")})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
