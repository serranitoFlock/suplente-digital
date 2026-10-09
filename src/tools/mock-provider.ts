import type { ToolCall, ToolProvider } from "./types.js";

interface Ticket {
  key: string;
  summary: string;
  status: string;
  assignee: string;
  updated: string;
  lastComment: string;
}

interface FailedJob {
  pipeline: string;
  job: string;
  branch: string;
  failedAt: string;
  reason: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** Fictional fixture data so the bot runs end-to-end without credentials. */
const tickets: Ticket[] = [
  { key: "DEMO-101", summary: "Nuevo web component acme-card para el portal", status: "En revisión", assignee: "Equipo Frontend", updated: "2026-10-07", lastComment: "MR abierto, falta aprobación de arquitectura." },
  { key: "DEMO-102", summary: "El componente acme-header no carga desde el CDN en QA", status: "En progreso", assignee: "Equipo Frontend", updated: "2026-10-08", lastComment: "Se detectó versión inexistente en el manifiesto de QA." },
  { key: "DEMO-103", summary: "Publicar @acme/ui-kit 3.2.0 con el nuevo date-picker", status: "Listo para release", assignee: "Arquitectura Frontend", updated: "2026-10-06", lastComment: "Changelog aprobado; pendiente pipeline de release." },
  { key: "DEMO-104", summary: "Actualizar manifiesto del CDN para acme-footer 1.4.1", status: "Bloqueado", assignee: "Arquitectura Frontend", updated: "2026-10-02", lastComment: "Esperando validación funcional del equipo de producto." },
];

const failedJobs = (now: Date): FailedJob[] => [
  { pipeline: "acme-card-elements", job: "build:elements", branch: "feature/acme-card", failedAt: ago(now, 1), reason: "Error de compilación: input 'variant' no existe en AcmeCardComponent." },
  { pipeline: "acme-ui-kit", job: "test:unit", branch: "develop", failedAt: ago(now, 3), reason: "2 tests fallidos en date-picker.spec.ts (zona horaria)." },
  { pipeline: "acme-shell", job: "lint", branch: "main", failedAt: ago(now, 5), reason: "Regla no-unused-vars en app.config.ts." },
  { pipeline: "acme-header-elements", job: "deploy:cdn-qa", branch: "release/2.1.0", failedAt: ago(now, 20), reason: "Timeout subiendo bundle al CDN de QA." },
];

function ago(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY).toISOString();
}

export class MockToolProvider implements ToolProvider {
  readonly name = "mock";

  constructor(private readonly now: Date = new Date()) {}

  async call(call: ToolCall): Promise<string> {
    switch (call.tool) {
      case "get_ticket": {
        const key = call.args.key.toUpperCase();
        return JSON.stringify(tickets.find((t) => t.key === key) ?? { error: `No existe el ticket ${key}` });
      }
      case "search_tickets": {
        const query = call.args.query.toLowerCase();
        return JSON.stringify(tickets.filter((t) => `${t.key} ${t.summary}`.toLowerCase().includes(query)));
      }
      case "list_failed_pipelines": {
        const since = this.now.getTime() - call.args.sinceDays * DAY;
        return JSON.stringify(failedJobs(this.now).filter((job) => Date.parse(job.failedAt) >= since));
      }
    }
  }
}
