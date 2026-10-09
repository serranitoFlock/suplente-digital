import { describe, expect, it } from "vitest";
import { ANSWER_PROMPT } from "../src/graph/answer.js";

describe("answer prompt — informal questions", () => {
  it("asks the model to read typos and abbreviations by meaning and not to echo the typos", () => {
    expect(ANSWER_PROMPT).toMatch(/errores de tipeo/);
    expect(ANSWER_PROMPT).toMatch(/no repitas/i);
  });
});
