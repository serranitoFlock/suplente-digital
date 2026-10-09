import "dotenv/config";
import { resolve } from "node:path";
import { resolveLlmSettings, type LlmSettings } from "./llm.js";
import { resolveCostRates, type CostRates } from "./observability/tracing.js";
import { resolveMemoryTurns } from "./memory/conversation-memory.js";
import { resolveShowCitations } from "./presentation/format-answer.js";
import { resolveAllowedLinkHosts } from "./security/guards.js";
import { resolveConcurrency } from "./service/assistant-service.js";
import { resolveFlag } from "./rag/engram-config.js";

const root = process.cwd();
const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

export const config = {
  knowledgeDir: resolve(root, "knowledge"),
  indexPath: resolve(root, env("INDEX_PATH") ?? "data/index.json"),
  pendingPath: resolve(root, env("PENDING_PATH") ?? "data/pending.json"),
  /** One JSON trace per request (metadata only: no prompts or replies). */
  tracesPath: resolve(root, env("TRACES_PATH") ?? "data/traces.jsonl"),
  /** Daily conversation log directory (`LOG_DIR`): one `YYYY-MM-DD.jsonl` per local day, with questions and answers. */
  logDir: resolve(root, env("LOG_DIR") ?? "data/logs"),
  embeddingModel: env("EMBEDDING_MODEL") ?? "Xenova/multilingual-e5-small",
  transformersCacheDir: resolve(root, env("TRANSFORMERS_CACHE_DIR") ?? ".cache/transformers"),
  retrieval: { topK: 4, minScore: 0.82 },
  /**
   * Engram notes as a second knowledge source (see README, "Conocimiento desde Engram"):
   * `ENGRAM_SOURCES_CONFIG` (local allowlist, default `config/engram-sources.local.json`),
   * `ENGRAM_EXPORT_DIR` (default `data/engram`), `ENGRAM_REAL` (index the real exports, default true)
   * and `ENGRAM_SAMPLE` (index the fictional `knowledge/engram-sample.json`, default true).
   */
  engram: {
    configPath: resolve(root, env("ENGRAM_SOURCES_CONFIG") ?? "config/engram-sources.local.json"),
    exportDir: resolve(root, env("ENGRAM_EXPORT_DIR") ?? "data/engram"),
    samplePath: resolve(root, "knowledge/engram-sample.json"),
    includeReal: resolveFlag("ENGRAM_REAL", process.env.ENGRAM_REAL, true),
    includeSample: resolveFlag("ENGRAM_SAMPLE", process.env.ENGRAM_SAMPLE, true),
  },
  /** Output guard: replies may only link to these hosts and their subdomains (`ALLOWED_LINK_HOSTS`, comma-separated). */
  security: { allowedLinkHosts: resolveAllowedLinkHosts(process.env.ALLOWED_LINK_HOSTS) },
  /**
   * Background graph runs at once (`ASSISTANT_CONCURRENCY`, default 1) and turns of short-term
   * memory kept per requester (`MEMORY_TURNS`, default 6; 0 disables it).
   */
  assistant: {
    concurrency: resolveConcurrency(process.env.ASSISTANT_CONCURRENCY),
    memoryTurns: resolveMemoryTurns(process.env.MEMORY_TURNS),
  },
  /** Show `[n]` markers and the cited sources in replies (`SHOW_CITATIONS`, default false); logs always keep them. */
  presentation: { showCitations: resolveShowCitations(process.env.SHOW_CITATIONS) },
  mcp: {
    command: env("MCP_SERVER_COMMAND"),
    args: env("MCP_SERVER_ARGS")?.split(/\s+/) ?? [],
    toolNames: {
      get_ticket: env("MCP_TOOL_GET_TICKET") ?? "get_issue",
      search_tickets: env("MCP_TOOL_SEARCH_TICKETS") ?? "search_issues",
      list_failed_pipelines: env("MCP_TOOL_LIST_FAILED_PIPELINES") ?? "list_failed_pipelines",
    },
  },
} as const;

export type AppConfig = typeof config;

/** Estimated-cost rates (`LLM_COST_INPUT_PER_MTOK` / `LLM_COST_OUTPUT_PER_MTOK`, USD per million tokens, default 0). */
export function loadCostRates(): CostRates {
  return resolveCostRates(process.env);
}

/** LLM provider settings from the environment (`LLM_PROVIDER`, `LLM_MODEL`, ...). Throws on missing/invalid config. */
export function loadLlmSettings(): LlmSettings {
  return resolveLlmSettings(process.env);
}
