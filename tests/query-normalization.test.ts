import { describe, expect, it } from "vitest";
import { buildIndexFromDocs } from "../src/rag/ingest.js";
import { buildIdentifierVocabulary, identifierTokens, maskUnknownIdentifiers } from "../src/rag/query-normalization.js";
import { Retriever } from "../src/rag/retriever.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";

describe("identifierTokens", () => {
  it("finds kebab, scoped, dotted, namespaced and ticket-key tokens", () => {
    expect(identifierTokens("Publicar @acme/ui-kit con acme-card, app.config.ts, deploy:cdn-qa y DEMO-101.")).toEqual([
      "@acme/ui-kit",
      "acme-card",
      "app.config.ts",
      "deploy:cdn-qa",
      "DEMO-101",
    ]);
  });

  it("never treats plain words, numbers, versions or sentence punctuation as identifiers", () => {
    expect(identifierTokens("¿Qué reviso primero? El componente no carga, versión 4.2.1 a las 10:30.")).toEqual([]);
  });
});

describe("buildIdentifierVocabulary", () => {
  it("collects the corpus identifiers once, lowercased and sorted", () => {
    expect(buildIdentifierVocabulary(["acme-card y Acme-Card", "ver DEMO-101 y acme-button"])).toEqual(["acme-button", "acme-card", "demo-101"]);
  });
});

describe("maskUnknownIdentifiers", () => {
  const vocabulary = buildIdentifierVocabulary(["acme-card", "acme-button", "@acme/ui-kit", "DEMO-101", "DEMO-102", "kebab-case", "bundle.js"]);

  it("drops an identifier absent from the corpus when its naming family is known", () => {
    expect(maskUnknownIdentifiers("El componente acme-header no carga desde el CDN, ¿qué reviso primero?", vocabulary)).toBe(
      "El componente no carga desde el CDN, ¿qué reviso primero?",
    );
    expect(maskUnknownIdentifiers("¿Cómo publico @acme/charts?", vocabulary)).toBe("¿Cómo publico?");
    expect(maskUnknownIdentifiers("¿En qué estado está DEMO-999?", vocabulary)).toBe("¿En qué estado está?");
  });

  it("keeps identifiers the corpus mentions, ignoring case", () => {
    expect(maskUnknownIdentifiers("¿Por qué falla ACME-Card en Safari?", vocabulary)).toBe("¿Por qué falla ACME-Card en Safari?");
  });

  it("keeps unknown identifiers outside the corpus naming families (they may be what makes a question out of scope)", () => {
    for (const query of ["¿Cómo migro a server-side rendering?", "¿Usamos chart.js?", "¿Qué pasa con kebab-style?"]) {
      expect(maskUnknownIdentifiers(query, vocabulary)).toBe(query);
    }
  });

  it("is a no-op without a vocabulary and never empties the query", () => {
    expect(maskUnknownIdentifiers("acme-header no carga", [])).toBe("acme-header no carga");
    expect(maskUnknownIdentifiers("acme-header", vocabulary)).toBe("acme-header");
  });
});

describe("Retriever with an identifier vocabulary", () => {
  const docs = [
    { source: "deploy.md", markdown: "# Deploy\n\nDesplegar acme-card y acme-header en el CDN." },
    { source: "carga.md", markdown: "# Carga\n\nEl componente acme-card no carga: revisar la consola." },
  ];

  it("stores the corpus identifiers in the index and ranks with unknown ones masked", async () => {
    const embedder = new FakeEmbedder();
    const index = await buildIndexFromDocs(docs.map((d) => ({ ...d, markdown: d.markdown.replace("acme-header", "acme-footer") })), embedder);
    expect(index.identifiers).toEqual(expect.arrayContaining(["acme-card", "acme-footer"]));
    const retriever = new Retriever(index, embedder, { minScore: 0.1, docSlots: 1 });
    // "acme-footer" only appears in deploy.md; it is in the vocabulary, so it still steers the ranking.
    expect((await retriever.rank("acme-footer acme-footer acme-footer no carga"))[0]?.source).toBe("deploy.md");
    // "acme-zzz" is unknown in a known family ("acme-"): masked, so only "no carga" steers the ranking.
    expect((await retriever.rank("acme-zzz acme-zzz acme-zzz no carga"))[0]?.source).toBe("carga.md");
  });

  it("does not mask with an index built before the vocabulary existed", async () => {
    const embedder = new FakeEmbedder();
    const { identifiers: _dropped, ...legacy } = await buildIndexFromDocs(docs, embedder);
    const retriever = new Retriever(legacy, embedder, { minScore: 0.1 });
    const withMask = new Retriever({ ...legacy, identifiers: ["acme-card", "acme-button"] }, embedder, { minScore: 0.1 });
    const query = "acme-header acme-header acme-header no carga";
    expect((await retriever.rank(query))[0]?.source).toBe("deploy.md");
    expect((await withMask.rank(query))[0]?.source).toBe("carga.md");
  });
});
