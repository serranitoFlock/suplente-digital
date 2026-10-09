import { describe, expect, it } from "vitest";
import { contextualPassage, documentTitle } from "../src/rag/ingest.js";
import { mean, recallAtK, reciprocalRank } from "../src/rag/metrics.js";

describe("retrieval metrics", () => {
  const ranked = ["a.md", "b.md", "a.md", "c.md", "d.md"];

  it("recall@k is the share of expected docs found in the top k chunks (duplicates count once)", () => {
    expect(recallAtK(ranked, ["a.md"], 1)).toBe(1);
    expect(recallAtK(ranked, ["c.md"], 3)).toBe(0);
    expect(recallAtK(ranked, ["c.md"], 4)).toBe(1);
    expect(recallAtK(ranked, ["b.md", "z.md"], 5)).toBe(0.5);
  });

  it("reciprocal rank uses the first relevant chunk, 0 when none is retrieved", () => {
    expect(reciprocalRank(ranked, ["a.md"])).toBe(1);
    expect(reciprocalRank(ranked, ["c.md", "b.md"])).toBe(0.5);
    expect(reciprocalRank(ranked, ["z.md"])).toBe(0);
  });

  it("rejects cases without expected sources and averages safely", () => {
    expect(() => recallAtK(ranked, [], 3)).toThrow();
    expect(mean([1, 0.5, 0])).toBe(0.5);
    expect(mean([])).toBeUndefined();
  });
});

describe("contextual chunk header", () => {
  it("takes the document title from the first H1, ignoring HTML comments", () => {
    expect(documentTitle("<!--\n# Not this\n-->\n# Publicar una librería\n\nIntro.\n\n## Pasos")).toBe("Publicar una librería");
    expect(documentTitle("Sin títulos")).toBe("");
  });

  it("prepends the document title and heading path to the chunk text", () => {
    const chunk = { id: "x#1", source: "x.md", heading: "Publicar una librería > Pasos", text: "Correr el pipeline." };
    expect(contextualPassage(chunk, "Publicar una librería")).toBe(
      "Documento: Publicar una librería\nSección: Publicar una librería > Pasos\nCorrer el pipeline.",
    );
    expect(contextualPassage({ ...chunk, heading: "" }, "")).toBe("Documento: x.md\nCorrer el pipeline.");
  });
});
