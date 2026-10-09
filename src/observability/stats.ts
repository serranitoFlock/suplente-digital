import type { TraceSummary } from "./tracing.js";

export interface SessionStats {
  requests: number;
  p50Ms?: number;
  p95Ms?: number;
  /** Requests whose LLM calls all reported token usage. */
  withUsage: number;
  /** Averages over `withUsage` requests. */
  avgInputTokens?: number;
  avgOutputTokens?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

/** Nearest-rank percentile; undefined for an empty list. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function computeStats(summaries: TraceSummary[]): SessionStats {
  const durations = summaries.map((s) => s.durationMs);
  const reported = summaries.filter((s) => s.usageReported && s.llmCalls > 0);
  const avg = (key: "inputTokens" | "outputTokens") =>
    reported.length ? reported.reduce((total, s) => total + s[key], 0) / reported.length : undefined;
  return {
    requests: summaries.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    withUsage: reported.length,
    avgInputTokens: avg("inputTokens"),
    avgOutputTokens: avg("outputTokens"),
    totalInputTokens: summaries.reduce((total, s) => total + s.inputTokens, 0),
    totalOutputTokens: summaries.reduce((total, s) => total + s.outputTokens, 0),
    totalCostUsd: summaries.reduce((total, s) => total + s.costUsd, 0),
  };
}

const seconds = (ms: number | undefined) => (ms === undefined ? "n/d" : `${(ms / 1000).toFixed(1)} s`);
const tokens = (value: number | undefined) => (value === undefined ? "n/d" : String(Math.round(value)));

export function formatUsd(value: number): string {
  return `US$ ${value.toFixed(value > 0 && value < 0.01 ? 6 : 4)}`;
}

/** Spanish summary for the CLI `/stats` command. */
export function renderStats(stats: SessionStats): string {
  if (stats.requests === 0) return "Todavía no hay consultas procesadas en esta sesión.";
  return [
    `Consultas procesadas: ${stats.requests}`,
    `Latencia: p50 ${seconds(stats.p50Ms)} · p95 ${seconds(stats.p95Ms)}`,
    `Tokens promedio por consulta: entrada ${tokens(stats.avgInputTokens)} · salida ${tokens(stats.avgOutputTokens)} (con uso reportado: ${stats.withUsage}/${stats.requests})`,
    `Costo estimado total: ${formatUsd(stats.totalCostUsd)}${stats.totalCostUsd === 0 ? " (tarifas en 0: modelo local o LLM_COST_* sin configurar)" : ""}`,
  ].join("\n");
}
