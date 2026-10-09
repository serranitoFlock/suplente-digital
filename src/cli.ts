import { clearLine, createInterface, cursorTo } from "node:readline";
import { HELP_TEXT, parseCommand, renderJobs } from "./cli-commands.js";
import { config, loadLlmSettings } from "./config.js";
import { buildGraph } from "./graph/graph.js";
import { createLlm, describeLlm } from "./llm.js";
import { PendingStore } from "./pending/store.js";
import { renderWelcomeBack } from "./pending/summary.js";
import { LocalE5Embedder } from "./rag/embeddings.js";
import { Retriever } from "./rag/retriever.js";
import { AssistantService, graphRunner, type DecisionResult } from "./service/assistant-service.js";
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
  const service = new AssistantService(graphRunner(graph), { concurrency: config.assistant.concurrency, threadPrefix: `cli-${Date.now()}` });
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "vos> " });
  let closing = false;

  /** Prints output that arrives while the user may be typing, then redraws the prompt and their partial line. */
  const print = (text: string) => {
    if (process.stdout.isTTY) {
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
    }
    process.stdout.write(`${text}\n`);
    if (!closing) rl.prompt(true);
  };

  service.on("done", (e) => print(`\nsuplente [#${e.id} · ${e.route ?? "?"}]> ${e.answer}\n`));
  service.on("failed", (e) => print(`\nsuplente [#${e.id}]> ${e.message}\n(detalle técnico: ${e.error})\n`));
  service.on("needs_approval", (e) =>
    print(
      `\n[#${e.id}] Pedido sensible: requiere aprobación del backup humano. El bot no ejecuta la acción.\n${e.draft}\n` +
        `→ /aprobar ${e.id} [nota]  o  /rechazar ${e.id} [nota]\n`,
    ),
  );

  const decisionMessage = (id: number, result: DecisionResult, verb: string) =>
    result === "accepted"
      ? `Decisión registrada para la consulta #${id} (${verb}). Te aviso cuando termine.`
      : result === "not_found"
        ? `No existe la consulta #${id}.`
        : `La consulta #${id} no está esperando aprobación.`;

  rl.on("line", (line) => {
    const command = parseCommand(line);
    switch (command.kind) {
      case "empty":
        break;
      case "ask":
        print(`suplente> ${service.submit(command.text).ack}`);
        return;
      case "approve":
        print(decisionMessage(command.id, service.approve(command.id, command.note), "aprobada"));
        return;
      case "reject":
        print(decisionMessage(command.id, service.reject(command.id, command.note), "rechazada"));
        return;
      case "status":
        print(renderJobs(service.list()));
        return;
      case "pending":
        void pending.list().then((entries) => print(`${renderWelcomeBack(entries)}\n`));
        return;
      case "help":
        print(HELP_TEXT);
        return;
      case "invalid":
        print(command.message);
        return;
      case "quit":
        rl.close();
        return;
    }
    rl.prompt();
  });

  // Fires on /salir and on end of input (e.g. piped stdin): let running work finish before leaving.
  rl.on("close", () => {
    closing = true;
    void (async () => {
      const inFlight = service.list().filter((job) => job.status === "queued" || job.status === "running");
      if (inFlight.length > 0) print(`Esperando ${inFlight.length} consulta(s) en curso…`);
      await service.idle();
      const awaiting = service.list().filter((job) => job.status === "needs_approval");
      if (awaiting.length > 0) {
        print(`Quedaron ${awaiting.length} pedido(s) sin decisión (${awaiting.map((j) => `#${j.id}`).join(", ")}); no se ejecutó nada.`);
      }
      await tools.close?.();
    })().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  });

  console.log(`Suplente digital (modelo ${describeLlm(llmSettings)}, herramientas: ${tools.name}).`);
  console.log(`Escribí tu consulta: te confirmo al instante y te respondo cuando esté lista. ${HELP_TEXT}\n`);
  rl.prompt();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
