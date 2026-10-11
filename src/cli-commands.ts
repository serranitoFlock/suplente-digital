import type { JobStatus, JobView, RecoveryReport } from "./service/assistant-service.js";

export type CliCommand =
  | { kind: "empty" }
  | { kind: "ask"; text: string }
  | { kind: "approve" | "reject"; id: number; note?: string }
  | { kind: "status" | "pending" | "stats" | "log" | "quit" | "help" }
  | { kind: "invalid"; message: string };

export const HELP_TEXT =
  "Comandos: /aprobar <número> [nota], /rechazar <número> [nota], /estado, /pendientes, /stats, /log, /ayuda, /salir. Cualquier otro texto es una consulta.";

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
    case "/stats":
      return { kind: "stats" };
    case "/log":
      return { kind: "log" };
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

/**
 * Startup line describing what `AssistantService.recover()` picked up from the previous run, or `undefined`
 * when nothing was left over (so a fresh start prints nothing extra).
 */
export function renderRecovery(report: RecoveryReport): string | undefined {
  const lines: string[] = [];
  const ids = (list: number[]) => list.map((id) => `#${id}`).join(", ");
  if (report.pending.length > 0) {
    lines.push(
      `${report.pending.length} pedido(s) siguen esperando aprobación (${ids(report.pending)}): ` +
        "ver /pendientes o /estado, y decidir con /aprobar <número> o /rechazar <número>.",
    );
  }
  const continued = [...report.requeued, ...report.rerun].sort((a, b) => a - b);
  if (continued.length > 0) {
    lines.push(`${continued.length} consulta(s) sin terminar se vuelven a procesar (${ids(continued)}); te respondo cuando estén listas.`);
  }
  if (report.resumed.length > 0) {
    lines.push(`${report.resumed.length} pedido(s) ya decididos se completan ahora (${ids(report.resumed)}).`);
  }
  return lines.length > 0 ? `Recuperado de la sesión anterior:\n- ${lines.join("\n- ")}` : undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
