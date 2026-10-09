import { describe, expect, it } from "vitest";
import { parseCommand, renderJobs } from "../src/cli-commands.js";
import type { JobView } from "../src/service/assistant-service.js";

describe("parseCommand", () => {
  it("treats plain text as a question", () => {
    expect(parseCommand("  ¿Cómo publico?  ")).toEqual({ kind: "ask", text: "¿Cómo publico?" });
    expect(parseCommand("   ")).toEqual({ kind: "empty" });
  });

  it("parses approval commands with optional notes", () => {
    expect(parseCommand("/aprobar 3")).toEqual({ kind: "approve", id: 3, note: undefined });
    expect(parseCommand("/aprobar #4 lo hace Juan")).toEqual({ kind: "approve", id: 4, note: "lo hace Juan" });
    expect(parseCommand("/rechazar 2 esperar a la vuelta")).toEqual({ kind: "reject", id: 2, note: "esperar a la vuelta" });
    expect(parseCommand("/aprobar")).toEqual({ kind: "invalid", message: expect.stringMatching(/\/aprobar <número>/) });
  });

  it("parses the other commands and rejects unknown ones", () => {
    expect(parseCommand("/estado")).toEqual({ kind: "status" });
    expect(parseCommand("/pendientes")).toEqual({ kind: "pending" });
    expect(parseCommand("/salir")).toEqual({ kind: "quit" });
    expect(parseCommand("/ayuda")).toEqual({ kind: "help" });
    expect(parseCommand("/stats")).toEqual({ kind: "stats" });
    expect(parseCommand("/foo").kind).toBe("invalid");
  });
});

describe("renderJobs", () => {
  it("lists jobs with status labels", () => {
    const job = (id: number, status: JobView["status"], question: string): JobView => ({ id, status, question, createdAt: "", updatedAt: "" });
    const text = renderJobs([job(1, "done", "¿Cómo publico?"), job(2, "needs_approval", "Borrá la rama")]);
    expect(text).toContain("#1 [lista] ¿Cómo publico?");
    expect(text).toContain("#2 [esperando aprobación] Borrá la rama");
    expect(renderJobs([])).toBe("No hay consultas todavía.");
  });
});
