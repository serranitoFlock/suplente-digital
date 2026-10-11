import { createAssistant } from "./assistant.js";
import { resolveApiConfig } from "./http/config.js";
import { createApiServer } from "./http/server.js";

/**
 * HTTP API entry point (`npm run serve`). Uses the same database as the CLI: run one or the other on a database,
 * never both at once (the job queue and the recovery assume a single owner).
 */
async function main(): Promise<void> {
  // Validate the API settings before loading models or opening the database.
  const api = resolveApiConfig(process.env);
  const assistant = await createAssistant();
  const { service } = assistant;
  // No interactive listeners: the API streams events to its own subscribers (`GET /v1/events`).
  const server = createApiServer({ service, pending: assistant.pending, tokens: api.tokens, config: assistant.runtime });

  const { pending, requeued, rerun, resumed } = service.recover();
  console.error(`Suplente digital API (${assistant.description}).`);
  console.error(
    `Recuperado: ${pending.length} esperando aprobación, ${requeued.length + rerun.length} sin terminar vueltos a procesar, ${resumed.length} decididos reanudados.`,
  );

  server.listen(api.port, api.host, () => console.error(`Escuchando en http://${api.host}:${api.port}`));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`${signal}: dejo de aceptar pedidos y espero las consultas en curso…`);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    await service.idle();
    // Ends open event streams so `close` can finish.
    server.closeAllConnections();
    await closed;
    await assistant.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      shutdown(signal).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
    });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
