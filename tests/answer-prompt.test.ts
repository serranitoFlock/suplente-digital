import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ANSWER_PROMPT } from "../src/graph/answer.js";
import { chunkMarkdown } from "../src/rag/chunk.js";

describe("answer prompt — informal questions", () => {
  it("asks the model to read typos and abbreviations by meaning and not to echo the typos", () => {
    expect(ANSWER_PROMPT).toMatch(/errores de tipeo/);
    expect(ANSWER_PROMPT).toMatch(/no repitas/i);
  });
});

describe("knowledge/glosario.md", () => {
  it("maps informal abbreviations to their meaning in a single chunk (never crowds the doc slots)", async () => {
    const markdown = await readFile(new URL("../knowledge/glosario.md", import.meta.url), "utf8");
    const chunks = chunkMarkdown("glosario.md", markdown);
    expect(chunks).toHaveLength(1);
    for (const term of ["WC", "web component", "MR", "merge request", "lib", "shell", "CDN", "manifiesto", "pipeline", "job", "QA", "prod"]) {
      expect(chunks[0]!.text.toLowerCase()).toContain(term.toLowerCase());
    }
  });
});
