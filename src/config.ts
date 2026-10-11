import "dotenv/config";
import { resolve } from "node:path";
import { resolveLlmSettings, type LlmSettings } from "./llm.js";
import { resolveCostRates, type CostRates } from "./observability/tracing.js";
import { resolveMemoryTurns } from "./memory/conversation-memory.js";
import { resolveShowCitations } from "./presentation/format-answer.js";
import { resolveAllowedLinkHosts } from "./security/guards.js";
import { resolveConcurrency } from "./service/assistant-service.js";
import { resolveFlag } from "./rag/engram-config.js";
import { DEFAULT_CONTEXT, resolveSlotCount } from "./rag/context-selection.js";
import { resolveCallTimeoutMs } from "./tools/mcp-config.js";

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
  /**
   * Answer context (see `selectContext`): candidates above `minScore`, then up to `docSlots` chunks
   * from `knowledge/*.md` (`RETRIEVAL_DOC_SLOTS`, default 4) and up to `engramSlots` Engram chunks
   * (`RETRIEVAL_ENGRAM_SLOTS`, default 2), curated docs first; the best curated doc brings its other
   * sections (small-to-big) within `maxContextChars`; candidates more than `maxScoreGap` below the best
   * chunk are dropped.
   */
  retrieval: {
    minScore: 0.82,
    candidates: DEFAULT_CONTEXT.candidates,
    docSlots: resolveSlotCount("RETRIEVAL_DOC_SLOTS", process.env.RETRIEVAL_DOC_SLOTS, DEFAULT_CONTEXT.docSlots),
    engramSlots: resolveSlotCount("RETRIEVAL_ENGRAM_SLOTS", process.env.RETRIEVAL_ENGRAM_SLOTS, DEFAULT_CONTEXT.engramSlots),
    maxScoreGap: 0.05,
    expandSiblings: true,
    maxContextChars: DEFAULT_CONTEXT.maxContextChars,
  },
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
  /**
   * MCP server for the read-only tools. `MCP_TOOLS_CONFIG` (default `config/mcp-tools.local.json`,
   * optional) maps each tool to a remote name and arguments; without it the `MCP_TOOL_*` names are used
   * with the arguments unchanged. `MCP_CALL_TIMEOUT_MS` (default 20000) bounds every tool call.
   */
  mcp: {
    command: env("MCP_SERVER_COMMAND"),
    toolsConfigPath: resolve(root, env("MCP_TOOLS_CONFIG") ?? "config/mcp-tools.local.json"),
    callTimeoutMs: resolveCallTimeoutMs(process.env.MCP_CALL_TIMEOUT_MS),
    args: env("MCP_SERVER_ARGS")?.split(/\s+/) ?? [],
    toolNames: {
      get_ticket: env("MCP_TOOL_GET_TICKET") ?? "get_issue",
      search_tickets: env("MCP_TOOL_SEARCH_TICKETS") ?? "search_issues",
      list_failed_pipelines: env("MCP_TOOL_LIST_FAILED_PIPELINES") ?? "list_failed_pipelines",
    },
  },
  /**
   * Human-registered read-only query scripts (`SCRIPTS_CONFIG`, default `config/scripts.local.json`,
   * optional; see `config/scripts.example.json`). Command and cwd paths resolve against the repo root.
   */
  scripts: {
    configPath: resolve(root, env("SCRIPTS_CONFIG") ?? "config/scripts.local.json"),
    root,
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
