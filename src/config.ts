import "dotenv/config";
import { resolve } from "node:path";
import { resolveLlmSettings, type LlmSettings } from "./llm.js";
import { resolveConcurrency } from "./service/assistant-service.js";

const root = process.cwd();
const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

export const config = {
  knowledgeDir: resolve(root, "knowledge"),
  indexPath: resolve(root, env("INDEX_PATH") ?? "data/index.json"),
  pendingPath: resolve(root, env("PENDING_PATH") ?? "data/pending.json"),
  embeddingModel: env("EMBEDDING_MODEL") ?? "Xenova/multilingual-e5-small",
  transformersCacheDir: resolve(root, env("TRANSFORMERS_CACHE_DIR") ?? ".cache/transformers"),
  retrieval: { topK: 4, minScore: 0.82 },
  /** Background graph runs at once (`ASSISTANT_CONCURRENCY`, default 1). */
  assistant: { concurrency: resolveConcurrency(process.env.ASSISTANT_CONCURRENCY) },
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

/** LLM provider settings from the environment (`LLM_PROVIDER`, `LLM_MODEL`, ...). Throws on missing/invalid config. */
export function loadLlmSettings(): LlmSettings {
  return resolveLlmSettings(process.env);
}
