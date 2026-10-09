import { describe, expect, it } from "vitest";
import { detectSensitive, parseRouterOutput } from "../src/graph/router.js";

describe("parseRouterOutput", () => {
  it("parses a valid JSON decision", () => {
    expect(parseRouterOutput('{"route":"task","topic":"jira","reason":"pide estado"}')).toEqual({
      route: "task",
      topic: "jira",
      reason: "pide estado",
    });
  });

  it("extracts JSON wrapped in prose or code fences", () => {
    const text = 'Claro:\n```json\n{"route": "question", "topic": "cdn", "reason": "duda"}\n```';
    expect(parseRouterOutput(text).route).toBe("question");
  });

  it("normalizes the topic to a slug and defaults it", () => {
    expect(parseRouterOutput('{"route":"question","topic":"Web Components!","reason":"x"}').topic).toBe("web-components");
    expect(parseRouterOutput('{"route":"question","reason":"x"}').topic).toBe("general");
  });

  it("falls back to a safe question route on invalid output", () => {
    for (const bad of ["no json here", '{"route":"delete_everything"}', "{broken"]) {
      const decision = parseRouterOutput(bad);
      expect(decision.route).toBe("question");
      expect(decision.reason).toMatch(/fallback/);
    }
  });
});

describe("detectSensitive", () => {
  it.each([
    "¿Podés borrar la rama release/1.2?",
    "Hacé el deploy a producción del componente",
    "Mergeá el MR 42 por favor",
    "Pasame el token del registry",
    "Revocá el acceso de Juan",
  ])("flags irreversible or secret requests: %s", (q) => {
    expect(detectSensitive(q)).toBe(true);
  });

  it.each([
    "¿Cómo publico una versión de la librería?",
    "¿Qué pipelines fallaron esta semana?",
    "¿En qué estado está DEMO-101?",
    "¿Quién aprueba los releases?",
    "¿Cómo armo un merge request?",
    "Necesito un borrador del changelog",
  ])(
    "does not flag routine requests: %s",
    (q) => {
      expect(detectSensitive(q)).toBe(false);
    },
  );
});
