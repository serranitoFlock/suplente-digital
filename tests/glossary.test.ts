import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GLOSSARY_FILE, normalizeQuery, parseGlossary } from "../src/rag/glossary.js";
import { buildIndexFromDocs, loadKnowledge } from "../src/rag/ingest.js";
import { Retriever } from "../src/rag/retriever.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";

const table = `# Glosario

Intro.

| Se dice | En la documentación | Qué es |
|---|---|---|
| wc, wcs, **webcomponent** | web component | Componente. |
| master | main | Rama. |
| backup | backup humano | Quien cubre. |
| \`QA\`, prod | — | Ambientes. |
`;

describe("parseGlossary", () => {
  it("reads alias → documentation term rows and skips definition-only rows", () => {
    expect(parseGlossary(table)).toEqual([
      { aliases: ["wc", "wcs", "webcomponent"], canonical: "web component" },
      { aliases: ["master"], canonical: "main" },
      { aliases: ["backup"], canonical: "backup humano" },
    ]);
  });
});

describe("normalizeQuery", () => {
  const rewrites = parseGlossary(table);

  it("replaces whole-word aliases, ignoring case", () => {
    expect(normalizeQuery("no me andan los wc, qué reviso?", rewrites)).toBe("no me andan los web component, qué reviso?");
    expect(normalizeQuery("¿Quién aprueba el MR a Master? Los WCS no cargan", rewrites)).toBe("¿Quién aprueba el MR a main? Los web component no cargan");
  });

  it("leaves words that only contain an alias, and terms already written in full, untouched", () => {
    expect(normalizeQuery("reglas wcag del mastermind", rewrites)).toBe("reglas wcag del mastermind");
    expect(normalizeQuery("hablé con el backup humano y con el backup", rewrites)).toBe("hablé con el backup humano y con el backup humano");
  });
});

describe("knowledge/glosario.md", () => {
  it("is a query-rewrite table, kept out of the indexed documents", async () => {
    const markdown = await readFile(new URL(`../knowledge/${GLOSSARY_FILE}`, import.meta.url), "utf8");
    const rewrites = parseGlossary(markdown);
    expect(rewrites).toContainEqual(expect.objectContaining({ canonical: "web component", aliases: expect.arrayContaining(["wc"]) }));
    expect(rewrites.find((r) => r.aliases.includes("master"))?.canonical).toBe("main");
    const docs = await loadKnowledge(new URL("../knowledge", import.meta.url).pathname);
    expect(docs.map((d) => d.source)).not.toContain(GLOSSARY_FILE);
  });
});

describe("Retriever with query rewrites", () => {
  it("searches with the normalized query when the index carries rewrites", async () => {
    const embedder = new FakeEmbedder();
    const index = await buildIndexFromDocs(
      [
        { source: "wc.md", markdown: "# Web component\n\nEl web component no aparece en el shell." },
        { source: "otro.md", markdown: "# Vacaciones\n\nQuién cubre las guardias." },
      ],
      embedder,
      parseGlossary(table),
    );
    expect(index.queryRewrites).toHaveLength(3);
    const retriever = new Retriever(index, embedder, { minScore: 0.1, docSlots: 1 });
    expect((await retriever.retrieve("el wc"))[0]?.source).toBe("wc.md");
  });
});
