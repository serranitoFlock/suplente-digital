import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/rag/chunk.js";

const doc = `# Publicar una librería

Intro general.

## Versionado

Usamos semver. Un cambio que rompe la API sube la versión mayor.

## Publicación

Ejecutar el pipeline de release.

### Rollback

Volver a la versión anterior en el manifiesto.
`;

describe("chunkMarkdown", () => {
  it("splits by headings and keeps the heading path", () => {
    const chunks = chunkMarkdown("librerias.md", doc);
    expect(chunks.map((c) => c.heading)).toEqual([
      "Publicar una librería",
      "Publicar una librería > Versionado",
      "Publicar una librería > Publicación",
      "Publicar una librería > Publicación > Rollback",
    ]);
    expect(chunks[1]?.text).toContain("semver");
    expect(chunks.every((c) => c.source === "librerias.md")).toBe(true);
  });

  it("assigns stable unique ids", () => {
    const ids = chunkMarkdown("a.md", doc).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("a.md#0");
  });

  it("splits long sections by paragraph without exceeding the limit", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Párrafo ${i} ` + "x".repeat(150));
    const chunks = chunkMarkdown("long.md", `# Largo\n\n${paragraphs.join("\n\n")}`, 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 400)).toBe(true);
    expect(chunks.every((c) => c.heading === "Largo")).toBe(true);
  });

  it("drops empty sections", () => {
    const chunks = chunkMarkdown("e.md", "# Solo título\n\n## Otro\n\nContenido");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe("Solo título > Otro");
  });
});
