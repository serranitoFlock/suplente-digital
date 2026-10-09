import { createInterface } from "node:readline/promises";
import { config, loadLlmSettings } from "./config.js";
import { askAgent, buildGraph, resumeAgent, type AgentTurn } from "./graph/graph.js";
import { createLlm, describeLlm } from "./llm.js";
import { PendingStore } from "./pending/store.js";
import { renderWelcomeBack } from "./pending/summary.js";
import { LocalE5Embedder } from "./rag/embeddings.js";
import { Retriever } from "./rag/retriever.js";
import { createToolProvider } from "./tools/mcp-provider.js";

async function main(): Promise<void> {
  const llmSettings = loadLlmSettings();

  const pending = new PendingStore(config.pendingPath);
  const tools = await createToolProvider(config.mcp);
  const retriever = await Retriever.load(
    config.indexPath,
    new LocalE5Embedder(config.embeddingModel, config.transformersCacheDir),
    config.retrieval,
  );
  const graph = buildGraph({ llm: createLlm(llmSettings), retriever, tools, pending });
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`Suplente digital (modelo ${describeLlm(llmSettings)}, herramientas: ${tools.name}).`);
  console.log("Escribí tu consulta. Comandos: /pendientes, /salir\n");

  try {
    for (let turnNumber = 1; ; turnNumber++) {
      const question = (await rl.question("vos> ")).trim();
      if (!question) continue;
      if (question === "/salir") break;
      if (question === "/pendientes") {
        console.log(renderWelcomeBack(await pending.list()), "\n");
        continue;
      }

      const threadId = `cli-${Date.now()}-${turnNumber}`;
      let turn: AgentTurn = await askAgent(graph, question, threadId);

      if (turn.review) {
        console.log("\n[Pedido sensible: requiere aprobación del backup humano]");
        console.log(turn.review.draft, "\n");
        const approved = (await rl.question("backup> ¿Aprobar la respuesta propuesta? (s/n) ")).trim().toLowerCase() === "s";
        const note = (await rl.question("backup> Nota opcional: ")).trim() || undefined;
        turn = await resumeAgent(graph, { approved, note }, threadId);
      }

      console.log(`\nsuplente [${turn.state.route}]> ${turn.state.answer}\n`);
    }
  } finally {
    rl.close();
    await tools.close?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
