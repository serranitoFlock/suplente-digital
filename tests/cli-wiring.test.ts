import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderRecovery } from "../src/cli-commands.js";
import { openAssistantStores, type AssistantStores } from "../src/persistence/assistant-db.js";
import { AssistantService, type AgentRunner } from "../src/service/assistant-service.js";
import { ControlledRunner, needsReview, nextEvent } from "./helpers/controlled-runner.js";

let dir: string;
const opened: AssistantStores[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cli-wiring-"));
});

afterEach(async () => {
  for (const stores of opened.splice(0)) stores.close();
  await rm(dir, { recursive: true, force: true });
});

/** Mirrors the CLI wiring: one database (nested path, created on demand) with every store on it. */
function boot(runner: AgentRunner) {
  const stores = openAssistantStores(join(dir, "nested", "assistant.db"), { memoryTurns: 2 });
  opened.push(stores);
  const service = new AssistantService(runner, { jobs: stores.jobs, memory: stores.memory });
  return { stores, service };
}

describe("CLI persistence wiring", () => {
  it("creates every schema on a fresh database and reports nothing to recover", () => {
    const { stores, service } = boot(new ControlledRunner());
    const tables = (stores.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["checkpoints", "jobs", "conversation_turns", "schema_migrations"]));
    expect(renderRecovery(service.recover())).toBeUndefined();
  });

  it("recovers a job waiting for approval in the next session and tells the user how to decide it", async () => {
    const runner = new ControlledRunner();
    const first = boot(runner);
    first.service.recover();
    const approval = nextEvent(first.service, "needs_approval");
    const { id } = first.service.submit("Borrá la rama", { requester: "ana" });
    await runner.release("Borrá la rama", needsReview("Borrador"));
    await approval;
    await first.service.idle();
    first.stores.close();
    first.stores.close(); // idempotent, like the CLI shutdown path

    const second = boot(new ControlledRunner());
    const message = renderRecovery(second.service.recover());
    expect(message).toContain(`1 pedido(s) siguen esperando aprobación (#${id})`);
    expect(message).toContain("/aprobar <número>");
    expect(second.service.list().map((job) => [job.id, job.status])).toEqual([[id, "needs_approval"]]);
  });
});

describe("renderRecovery", () => {
  it("summarizes re-run, requeued and resumed jobs", () => {
    expect(renderRecovery({ pending: [], requeued: [5], rerun: [3], resumed: [2] })).toBe(
      "Recuperado de la sesión anterior:\n" +
        "- 2 consulta(s) sin terminar se vuelven a procesar (#3, #5); te respondo cuando estén listas.\n" +
        "- 1 pedido(s) ya decididos se completan ahora (#2).",
    );
  });
});
