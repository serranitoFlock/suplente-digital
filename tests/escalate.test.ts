import { describe, expect, it } from "vitest";
import { DRAFT_PROMPT, proposedReply } from "../src/graph/escalate.js";

describe("proposedReply", () => {
  it.each([
    ["markdown bold heading, quoted reply", '**Riesgos:** alto.\n**Respuesta propuesta para el usuario:**\n"Recibí tu pedido; lo revisa una persona."', "Recibí tu pedido; lo revisa una persona."],
    ["plain heading on the same line", "Riesgos: alto.\nRespuesta propuesta: Recibí tu pedido; lo revisa una persona.", "Recibí tu pedido; lo revisa una persona."],
    ["markdown header and several lines", "## Riesgos\nalto\n## Respuesta propuesta\nRecibí tu pedido.\nLo revisa una persona.", "Recibí tu pedido.\nLo revisa una persona."],
    ["stops at a following section", "**Respuesta propuesta:** Recibí tu pedido.\n**Notas internas:** revisar logs.", "Recibí tu pedido."],
    ["curly quotes and accents-free heading", "Respuesta propuesta al solicitante:\n“Recibí tu pedido.”", "Recibí tu pedido."],
  ])("extracts the reply (%s)", (_name, draft, expected) => {
    expect(proposedReply(draft)).toBe(expected);
  });

  it("returns undefined when the draft has no proposed reply", () => {
    expect(proposedReply("Riesgos: alto. Pasos: hacer backup.")).toBeUndefined();
    expect(proposedReply("**Respuesta propuesta:**\n")).toBeUndefined();
  });
});

describe("DRAFT_PROMPT", () => {
  it("asks for a final proposed-reply section that never promises the bot will act", () => {
    expect(DRAFT_PROMPT).toContain("Respuesta propuesta:");
    expect(DRAFT_PROMPT).toMatch(/no prometas|nunca prometas/i);
  });
});
