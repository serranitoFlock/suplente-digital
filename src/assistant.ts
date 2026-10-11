import { config, loadCostRates } from "./config.js";
import { buildGraph } from "./graph/graph.js";
import { DailyJsonlLog } from "./logging/conversation-log.js";
import { createLlm, describeLlm, SwitchableLlm } from "./llm.js";
import { JsonlTraceExporter, Tracer } from "./observability/tracing.js";
import { PendingStore } from "./pending/store.js";
import { openAssistantStores, type AssistantStores } from "./persistence/assistant-db.js";
import { SettingsStore } from "./persistence/settings-store.js";
import { LocalE5Embedder } from "./rag/embeddings.js";
import { Retriever } from "./rag/retriever.js";
import { loadBaseline, RuntimeConfig, SECRET_SETTING_KEYS } from "./runtime-config.js";
import { AssistantService, graphRunner } from "./service/assistant-service.js";
import { createBaseToolProvider } from "./tools/mcp-provider.js";
import { withReloadableScripts } from "./tools/script-provider.js";
import type { ToolProvider } from "./tools/types.js";

/** Everything a transport (CLI, HTTP API) needs, built from `config`, the environment and the panel settings. */
export interface Assistant {
  service: AssistantService;
  pending: PendingStore;
  log: DailyJsonlLog;
  tracer: Tracer;
  tools: ToolProvider;
  stores: AssistantStores;
  /** Effective settings (panel > env/files > defaults) and their hot changes (admin endpoints). */
  runtime: RuntimeConfig;
  /** Model, tools and scripts in one line, for the startup banner. */
  description: string;
  /** Releases tools, traces and the database; call it after `service.idle()`. */
  close(): Promise<void>;
}

/**
 * Opens the stores, resolves the effective configuration (settings table > `.env`/config files > defaults) and
 * builds the graph and the service. The caller attaches listeners, then calls `recover()`.
 */
export async function createAssistant(): Promise<Assistant> {
  const baseline = await loadBaseline({ env: process.env, mcpToolsPath: config.mcp.toolsConfigPath, scriptsPath: config.scripts.configPath });
  const stores = openAssistantStores(config.dbPath);
  let runtime: RuntimeConfig;
  let tools: ReturnType<typeof withReloadableScripts>;
  try {
    runtime = await RuntimeConfig.create({ store: new SettingsStore(stores.db, { secretKeys: SECRET_SETTING_KEYS }), baseline, scriptsRoot: config.scripts.root });
    const { mcp } = runtime.effective();
    const base = await createBaseToolProvider({
      command: mcp.serverCommand,
      args: mcp.serverArgs,
      toolNames: config.mcp.toolNames,
      mapping: mcp.toolsMapping,
      callTimeoutMs: mcp.callTimeoutMs,
    });
    // Always reloadable, so a registry set from the panel takes effect without a restart.
    tools = withReloadableScripts(base, runtime.registry());
  } catch (error) {
    stores.close();
    throw error;
  }
  const { assistant: assistantSettings } = runtime.effective();
  stores.memory.maxTurns = assistantSettings.memoryTurns;

  const tracer = new Tracer({ exporters: [new JsonlTraceExporter(config.tracesPath)], costRates: loadCostRates() });
  const pending = new PendingStore(config.pendingPath);
  const log = new DailyJsonlLog(config.logDir);
  const retriever = await Retriever.load(config.indexPath, new LocalE5Embedder(config.embeddingModel, config.transformersCacheDir), config.retrieval);
  // Each model call goes to the model current when it starts: after a panel change, running jobs use the new one
  // for their remaining calls.
  const llm = new SwitchableLlm(createLlm(runtime.llmSettings()));
  const graph = buildGraph(
    { llm: llm.call, retriever, tools, pending, allowedLinkHosts: config.security.allowedLinkHosts },
    stores.checkpointer,
  );
  // Thread ids use the service's stable default prefix (job ids are unique per database), so checkpoints
  // written before a restart are found again.
  const service = new AssistantService(graphRunner(graph, tracer), {
    concurrency: config.assistant.concurrency,
    jobs: stores.jobs,
    memory: stores.memory,
    showCitations: assistantSettings.showCitations,
    log,
  });
  runtime.setAppliers({
    llm: (settings) => llm.set(createLlm(settings)),
    memoryTurns: (turns) => {
      stores.memory.maxTurns = turns;
    },
    showCitations: (show) => service.setShowCitations(show),
    scripts: (registry) => tools.reload(registry),
  });
  return {
    service,
    pending,
    log,
    tracer,
    tools,
    stores,
    runtime,
    description: `modelo ${describeLlm(runtime.llmSettings())}, herramientas: ${tools.name}, scripts registrados: ${tools.scripts.size}`,
    close: async () => {
      await tools.close?.();
      await tracer.flush();
      stores.close();
    },
  };
}
