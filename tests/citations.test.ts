import { describe, expect, it } from "vitest";
import { citedNumbers, formatCitedSources, selectCitedSources } from "../src/graph/citations.js";
import { formatAnswerForUser, resolveShowCitations, stripCitations } from "../src/presentation/format-answer.js";

const sources = [
  { source: "a.md", heading: "A > Uno", score: 0.9 },
  { source: "b.md", heading: "B > Dos", score: 0.88 },
  { source: "c.md", heading: "C > Tres", score: 0.85 },
];

describe("cited sources", () => {
  it("parses single, grouped and range markers once each", () => {
    expect(citedNumbers("Uno [1]. Dos [3][1]. Tres [2, 3]. Rango [1-2].")).toEqual([1, 3, 2]);
    expect(citedNumbers("Sin citas.")).toEqual([]);
  });

  it("keeps only the cited sources with their original numbers", () => {
    const cited = selectCitedSources(sources, "Lo define el manifiesto [3]. Ver también [9].");
    expect(cited).toEqual([{ ...sources[2], n: 3 }]);
    expect(formatCitedSources(cited)).toBe("[3] c.md › C > Tres");
    expect(selectCitedSources(sources, "Sin citas.")).toEqual([]);
  });
});

describe("stripCitations", () => {
  it("removes markers and the sources block and tidies punctuation and spacing", () => {
    const answer = "Revisá el manifiesto [1]. Si da 404 [2], [3], subí la versión ([1]).\n\nFuentes:\n[1] a.md › A > Uno\n[2] b.md › B > Dos";
    expect(stripCitations(answer)).toBe("Revisá el manifiesto. Si da 404, subí la versión.");
  });

  it("handles adjacent markers, line starts and lists, and leaves inline code alone", () => {
    expect(stripCitations("Pasos:\n1. Crear el tag `items[0]` [1][2]\n  - Publicar [3] ahora")).toBe("Pasos:\n1. Crear el tag `items[0]`\n  - Publicar ahora");
    expect(stripCitations("Texto sin citas.")).toBe("Texto sin citas.");
  });

  it("respects SHOW_CITATIONS (default false)", () => {
    const answer = "Con changesets [1].\n\nFuentes:\n[1] a.md › A > Uno";
    expect(formatAnswerForUser(answer, { showCitations: false })).toBe("Con changesets.");
    expect(formatAnswerForUser(answer, { showCitations: true })).toBe(answer);
    expect(resolveShowCitations(undefined)).toBe(false);
    expect(resolveShowCitations("true")).toBe(true);
    expect(resolveShowCitations("0")).toBe(false);
    expect(() => resolveShowCitations("quizas")).toThrow(/SHOW_CITATIONS/);
  });
});
