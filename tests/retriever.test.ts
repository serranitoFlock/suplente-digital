import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "../src/rag/embeddings.js";
import { Retriever, rankChunks, type IndexedChunk } from "../src/rag/retriever.js";
import { buildIndexFromDocs } from "../src/rag/ingest.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for zero vectors and rejects mismatched dimensions", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow();
  });
});

describe("rankChunks", () => {
  const chunk = (id: string, embedding: number[]): IndexedChunk => ({
    id,
    source: `${id}.md`,
    heading: id,
    text: id,
    embedding,
  });

  it("orders by score, applies topK and minScore", () => {
    const chunks = [chunk("far", [0, 1]), chunk("near", [1, 0.1]), chunk("mid", [1, 1])];
    const ranked = rankChunks([1, 0], chunks, { topK: 2, minScore: 0.5 });
    expect(ranked.map((c) => c.id)).toEqual(["near", "mid"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(rankChunks([1, 0], chunks, { topK: 5, minScore: 0.99 }).map((c) => c.id)).toEqual(["near"]);
  });
});

describe("Retriever with fake embeddings", () => {
  it("finds the most relevant section for a query", async () => {
    const embedder = new FakeEmbedder();
    const index = await buildIndexFromDocs(
      [
        { source: "cdn.md", markdown: "# CDN\n\n## Manifiesto\n\nEl manifiesto de versiones del CDN define qué bundle carga cada componente." },
        { source: "vacaciones.md", markdown: "# Vacaciones\n\nCómo pedir días de vacaciones y quién cubre las guardias." },
      ],
      embedder,
    );
    const retriever = new Retriever(index, embedder, { topK: 1, minScore: 0.1 });
    const [best] = await retriever.retrieve("¿qué bundle carga el manifiesto del CDN?");
    expect(best?.source).toBe("cdn.md");
    expect(best?.heading).toBe("CDN > Manifiesto");
  });
});
