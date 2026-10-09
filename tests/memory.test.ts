import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../src/graph/state.js";
import { InMemoryConversationMemory, renderHistory, resolveMemoryTurns } from "../src/memory/conversation-memory.js";
import { CLARIFY_NO_CONTEXT, hasFollowUpReference, resolveReference } from "../src/memory/references.js";

const pipelines = [
  { pipeline: "acme-card-elements", job: "build:elements", reason: "input 'variant' no existe" },
  { pipeline: "acme-ui-kit", job: "test:unit", reason: "tests de zona horaria" },
  { pipeline: "acme-shell", job: "lint", reason: "no-unused-vars" },
];

const pipelineTurn: ConversationTurn = {
  question: "no me están funcionando los pipelines",
  route: "task",
  answer: "Fallaron 3 pipelines: acme-card-elements, acme-ui-kit y acme-shell.",
  toolResults: [{ tool: "list_failed_pipelines", args: { sinceDays: 7 }, readOnly: true, result: pipelines }],
};

const ticketTurn: ConversationTurn = {
  question: "¿En qué estado está DEMO-102?",
  route: "task",
  answer: "DEMO-102 está en progreso.",
  toolResults: [{ tool: "get_ticket", args: { key: "DEMO-102" }, readOnly: true, result: { key: "DEMO-102", summary: "acme-header no carga", status: "En progreso" } }],
};

describe("InMemoryConversationMemory", () => {
  it("keeps the last N turns per conversation, oldest first", async () => {
    const memory = new InMemoryConversationMemory(2);
    for (const q of ["q1", "q2", "q3"]) await memory.append("ana", { question: q, answer: `a-${q}`, toolResults: [] });
    await memory.append("beto", { question: "otra", answer: "x", toolResults: [] });
    expect((await memory.recent("ana")).map((t) => t.question)).toEqual(["q2", "q3"]);
    expect((await memory.recent("beto")).map((t) => t.question)).toEqual(["otra"]);
    expect(await memory.recent("nadie")).toEqual([]);
  });

  it("stores nothing when disabled with 0 turns", async () => {
    const memory = new InMemoryConversationMemory(0);
    await memory.append("ana", { question: "q", answer: "a", toolResults: [] });
    expect(await memory.recent("ana")).toEqual([]);
  });

  it("parses MEMORY_TURNS (default 6)", () => {
    expect(resolveMemoryTurns(undefined)).toBe(6);
    expect(resolveMemoryTurns("0")).toBe(0);
    expect(resolveMemoryTurns("10")).toBe(10);
    expect(() => resolveMemoryTurns("-1")).toThrow(/MEMORY_TURNS/);
    expect(() => resolveMemoryTurns("seis")).toThrow(/MEMORY_TURNS/);
  });

  it("renders history without the sources block", () => {
    const text = renderHistory([{ question: "¿Cómo publico?", route: "question", answer: "Con changesets [1].\n\nFuentes:\n[1] a.md › A", toolResults: [] }]);
    expect(text).toContain("Usuario: ¿Cómo publico?");
    expect(text).toContain("Suplente: Con changesets [1].");
    expect(text).not.toContain("Fuentes:");
  });
});

describe("resolveReference", () => {
  it('resolves "el primero que me pasaste" to the first item of the last list', () => {
    const resolution = resolveReference("es sobre el primero que me pasaste, que paso?", [pipelineTurn]);
    expect(resolution).toMatchObject({ kind: "resolved", item: { kind: "pipeline", data: { pipeline: "acme-card-elements" } } });
  });

  it("resolves ordinals with a noun and the last item", () => {
    expect(resolveReference("¿Y el segundo pipeline?", [pipelineTurn])).toMatchObject({ kind: "resolved", item: { data: { pipeline: "acme-ui-kit" } } });
    expect(resolveReference("contame del último", [pipelineTurn])).toMatchObject({ kind: "resolved", item: { data: { pipeline: "acme-shell" } } });
  });

  it("picks the latest result of the kind the question names", () => {
    const resolution = resolveReference("¿Qué pasó con el primer pipeline?", [pipelineTurn, ticketTurn]);
    expect(resolution).toMatchObject({ kind: "resolved", item: { data: { pipeline: "acme-card-elements" } } });
    expect(resolveReference("¿y ese ticket?", [pipelineTurn, ticketTurn])).toMatchObject({ kind: "resolved", item: { kind: "ticket", label: expect.stringContaining("DEMO-102") } });
  });

  it("asks instead of guessing when there is no history", () => {
    expect(resolveReference("es sobre el primero que me pasaste, que paso?", [])).toEqual({ kind: "ambiguous", message: CLARIFY_NO_CONTEXT });
  });

  it("asks when the reference matches several items or is out of range", () => {
    const several = resolveReference("¿Qué pasó con ese pipeline?", [pipelineTurn]);
    expect(several.kind).toBe("ambiguous");
    expect(several.kind === "ambiguous" && several.message).toMatch(/acme-card-elements.*acme-ui-kit/);
    expect(resolveReference("¿y el cuarto?", [pipelineTurn]).kind).toBe("ambiguous");
  });

  it("ignores messages without a back-reference or with an explicit id", () => {
    for (const q of [
      "¿Cómo creo el primer web component?",
      "¿Cuál es el primer paso para publicar una librería?",
      "¿Qué pipelines fallaron esta semana?",
      "¿Qué pasó con el primer job de acme-shell?",
      "¿Y el primero, DEMO-101?",
    ]) {
      expect(resolveReference(q, [pipelineTurn])).toEqual({ kind: "none" });
      expect(hasFollowUpReference(q)).toBe(false);
    }
  });
});
