import { config, loadCostRates, loadLlmSettings } from "./config.js";
import { buildGraph } from "./graph/graph.js";
import { DailyJsonlLog } from "./logging/conversation-log.js";
import { createLlm, describeLlm } from "./llm.js";
import { JsonlTraceExporter, Tracer } from "./observability/tracing.js";
import { PendingStore } from "./pending/store.js";
import { openAssistantStores, type AssistantStores } from "./persistence/assistant-db.js";
import { LocalE5Embedder } from "./rag/embeddings.js";
import { Retriever } from "./rag/retriever.js";
import { AssistantService, graphRunner } from "./service/assistant-service.js";
import { createToolProvider } from "./tools/mcp-provider.js";
import type { ToolProvider } from "./tools/types.js";

/** Everything a transport (CLI, HTTP API) needs, built from `config` and the environment. */
export interface Assistant {
  service: AssistantService;
  pending: PendingStore;
  log: DailyJsonlLog;
  tracer: Tracer;
  tools: ToolProvider;
  stores: AssistantStores;
  /** Model, tools and scripts in one line, for the startup banner. */
  description: string;
  /** Releases tools, traces and the database; call it after `service.idle()`. */
  close(): Promise<void>;
}

/** Opens the stores and builds the graph and the service. The caller attaches listeners, then calls `recover()`. */
export async function createAssistant(): Promise<Assistant> {
  const llmSettings = loadLlmSettings();
  const tracer = new Tracer({ exporters: [new JsonlTraceExporter(config.tracesPath)], costRates: loadCostRates() });
  const pending = new PendingStore(config.pendingPath);
  const log = new DailyJsonlLog(config.logDir);
  const stores = openAssistantStores(config.dbPath, { memoryTurns: config.assistant.memoryTurns });
  const tools = await createToolProvider(config.mcp, config.scripts);
  const retriever = await Retriever.load(config.indexPath, new LocalE5Embedder(config.embeddingModel, config.transformersCacheDir), config.retrieval);
  const graph = buildGraph(
    { llm: createLlm(llmSettings), retriever, tools, pending, allowedLinkHosts: config.security.allowedLinkHosts },
    stores.checkpointer,
  );
  // Thread ids use the service's stable default prefix (job ids are unique per database), so checkpoints
  // written before a restart are found again.
  const service = new AssistantService(graphRunner(graph, tracer), {
    concurrency: config.assistant.concurrency,
    jobs: stores.jobs,
    memory: stores.memory,
    showCitations: config.presentation.showCitations,
    log,
  });
  return {
    service,
    pending,
    log,
    tracer,
    tools,
    stores,
    description: `modelo ${describeLlm(llmSettings)}, herramientas: ${tools.name}, scripts registrados: ${tools.scripts?.size ?? 0}`,
    close: async () => {
      await tools.close?.();
      await tracer.flush();
      stores.close();
    },
  };
}
