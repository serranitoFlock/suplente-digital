import { describe, expect, it } from "vitest";
import { CAPABILITIES_MESSAGE, isCapabilitiesQuestion } from "../src/graph/capabilities.js";

describe("isCapabilitiesQuestion", () => {
  it.each([
    "como funciona tu funcionamiento?",
    "¿Qué podés hacer?",
    "¿Qué puedes hacer por mí?",
    "¿Cómo funcionás?",
    "¿Quién sos?",
    "¿Qué eres?",
    "ayuda",
    "¿Ayuda?",
    "¿En qué me podés ayudar?",
    "¿Qué cosas no podés hacer?",
    "¿Cómo funciona este bot?",
  ])("detects questions about the assistant: %s", (q) => {
    expect(isCapabilitiesQuestion(q)).toBe(true);
  });

  it.each([
    "¿Cómo funciona el manifiesto del CDN?",
    "¿Qué tengo que hacer para publicar una librería?",
    "Necesito ayuda con el pipeline de acme-shell",
    "¿Quién aprueba los releases?",
    "¿Qué pipelines fallaron esta semana?",
  ])("leaves team questions to the normal routes: %s", (q) => {
    expect(isCapabilitiesQuestion(q)).toBe(false);
  });
});

describe("CAPABILITIES_MESSAGE", () => {
  it("describes what the assistant can and cannot do, plus the CLI commands, without voseo", () => {
    for (const fact of ["documentación", "solo lectura", "backup humano", "No sé", "No puedo", "secretos", "/aprobar", "/pendientes", "/salir"]) {
      expect(CAPABILITIES_MESSAGE).toContain(fact);
    }
    expect(CAPABILITIES_MESSAGE).not.toMatch(/(?<!\p{L})(podés|tenés|querés|escribí|pedí)(?!\p{L})/u);
  });
});
