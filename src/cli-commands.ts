import type { JobStatus, JobView } from "./service/assistant-service.js";

export type CliCommand =
  | { kind: "empty" }
  | { kind: "ask"; text: string }
  | { kind: "approve" | "reject"; id: number; note?: string }
  | { kind: "status" | "pending" | "quit" | "help" }
  | { kind: "invalid"; message: string };

export const HELP_TEXT =
  "Comandos: /aprobar <número> [nota], /rechazar <número> [nota], /estado, /pendientes, /ayuda, /salir. Cualquier otro texto es una consulta.";

/** Parses one line typed in the CLI. Pure, so it is unit-tested without a terminal. */
export function parseCommand(line: string): CliCommand {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "ask", text };

  const [name = "", ...rest] = text.split(/\s+/);
  switch (name.toLowerCase()) {
    case "/aprobar":
    case "/rechazar": {
      const kind = name.toLowerCase() === "/aprobar" ? "approve" : "reject";
      const id = Number(rest[0]?.replace(/^#/, ""));
      if (!Number.isInteger(id) || id < 1) return { kind: "invalid", message: `Uso: ${name.toLowerCase()} <número> [nota]` };
      return { kind, id, note: rest.slice(1).join(" ") || undefined };
    }
    case "/estado":
      return { kind: "status" };
    case "/pendientes":
      return { kind: "pending" };
    case "/salir":
      return { kind: "quit" };
    case "/ayuda":
      return { kind: "help" };
    default:
      return { kind: "invalid", message: `Comando desconocido: ${name}. ${HELP_TEXT}` };
  }
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "en cola",
  running: "procesando",
  needs_approval: "esperando aprobación",
  done: "lista",
  failed: "falló",
};

export function renderJobs(jobs: JobView[]): string {
  if (jobs.length === 0) return "No hay consultas todavía.";
  return jobs.map((job) => `#${job.id} [${STATUS_LABELS[job.status]}] ${truncate(job.question, 70)}`).join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
