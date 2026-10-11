import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRAFT_PROMPT } from "../src/graph/escalate.js";
import { buildGraph } from "../src/graph/graph.js";
import { ROUTER_PROMPT } from "../src/graph/router.js";
import type { Llm } from "../src/llm.js";
import { PendingStore } from "../src/pending/store.js";
import { SqliteJobStore } from "../src/persistence/job-store.js";
import { SqliteCheckpointSaver } from "../src/persistence/sqlite-checkpointer.js";
import { SqliteConversationMemory } from "../src/persistence/sqlite-memory.js";
import { openDatabase } from "../src/persistence/sqlite.js";
import { Retriever } from "../src/rag/retriever.js";
import { AssistantService, graphRunner, type AgentRunner, type AssistantServiceOptions } from "../src/service/assistant-service.js";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import { answered, ControlledRunner, needsReview, nextEvent, waitFor } from "./helpers/controlled-runner.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";

let dir: string;
const opened: DatabaseSync[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "restart-"));
});

afterEach(async () => {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
  await rm(dir, { recursive: true, force: true });
});

function open(): DatabaseSync {
  const db = openDatabase(join(dir, "assistant.db"));
  opened.push(db);
  return db;
}

/** One "process": its own connection, job store and memory over the shared database file. */
function boot(runner: AgentRunner, options: AssistantServiceOptions = {}) {
  const db = open();
  const service = new AssistantService(runner, { jobs: new SqliteJobStore(db), memory: new SqliteConversationMemory(db), ...options });
  return { db, service };
}

async function pause(runner: ControlledRunner, service: AssistantService, question: string): Promise<number> {
  const approval = nextEvent(service, "needs_approval");
  const { id } = service.submit(question, { requester: "ana" });
  await runner.release(question, needsReview("Borrador"));
  await approval;
  return id;
}

describe("AssistantService restart (SQLite job store)", () => {
  it("keeps jobs waiting for approval and resumes them exactly once after a restart", async () => {
    const runnerA = new ControlledRunner();
    const a = boot(runnerA);
    const approveMe = await pause(runnerA, a.service, "Borrá la rama");
    const rejectMe = await pause(runnerA, a.service, "Dame admin");
    a.db.close();

    const runnerB = new ControlledRunner();
    const { service } = boot(runnerB);
    expect(service.recover()).toEqual({ pending: [approveMe, rejectMe], requeued: [], rerun: [], resumed: [] });
    expect(service.list().map((j) => [j.id, j.status])).toEqual([
      [approveMe, "needs_approval"],
      [rejectMe, "needs_approval"],
    ]);

    const done = nextEvent(service, "done");
    expect(service.approve(approveMe, "ok")).toBe("accepted");
    expect(await done).toMatchObject({ id: approveMe, answer: "aprobado" });
    expect(service.approve(approveMe)).toBe("not_pending");
    expect(service.reject(approveMe)).toBe("not_pending");

    const rejected = nextEvent(service, "done");
    expect(service.reject(rejectMe, "esperar")).toBe("accepted");
    expect(await rejected).toMatchObject({ id: rejectMe, answer: "rechazado" });
    expect(service.approve(999)).toBe("not_found");

    expect(runnerB.resumes).toEqual([
      { threadId: `job-${approveMe}`, decision: { approved: true, note: "ok" } },
      { threadId: `job-${rejectMe}`, decision: { approved: false, note: "esperar" } },
    ]);
    expect(service.status(approveMe)?.status).toBe("done");
  });

  it("lets only one of two services over the same database decide a job", async () => {
    const runnerA = new ControlledRunner();
    const runnerB = new ControlledRunner();
    const a = boot(runnerA);
    const b = boot(runnerB);
    const id = await pause(runnerA, a.service, "Borrá la rama");

    expect(b.service.status(id)?.status).toBe("needs_approval");
    expect(b.service.approve(id)).toBe("accepted");
    expect(a.service.approve(id)).toBe("not_pending");
    expect(a.service.reject(id)).toBe("not_pending");
    await b.service.idle();
    await a.service.idle();

    expect(runnerB.resumes).toHaveLength(1);
    expect(runnerA.resumes).toHaveLength(0);
    expect(a.service.status(id)?.status).toBe("done");
  });

  it("re-runs interrupted asks on a fresh thread and queued asks in per-requester order", async () => {
    const runnerA = new ControlledRunner();
    const a = boot(runnerA);
    a.service.submit("a1", { requester: "ana" });
    a.service.submit("a2", { requester: "ana" });
    a.service.submit("b1", { requester: "beto" });
    await waitFor(() => runnerA.asks.has("a1"));
    expect(a.service.status(1)?.status).toBe("running");
    a.db.close(); // crash: a1 never finishes, a2 and b1 never start

    const runnerB = new ControlledRunner();
    const { service } = boot(runnerB, { concurrency: 3 });
    expect(service.recover()).toEqual({ pending: [], requeued: [2, 3], rerun: [1], resumed: [] });

    await waitFor(() => runnerB.asks.has("a1") && runnerB.asks.has("b1"));
    expect(runnerB.asks.has("a2")).toBe(false);
    expect(runnerB.threadIds.get("a1")).toBe("job-1-a2");
    expect(runnerB.threadIds.get("b1")).toBe("job-3");

    await runnerB.release("a1", answered("r1"));
    await waitFor(() => runnerB.asks.has("a2"));
    expect(runnerB.histories.get("a2")?.map((t) => t.question)).toEqual(["a1"]);
    expect(runnerB.threadIds.get("a2")).toBe("job-2");
    await runnerB.release("a2", answered("r2"));
    await runnerB.release("b1", answered("rb"));
    await service.idle();
    expect(service.list().map((j) => j.status)).toEqual(["done", "done", "done"]);

    // Ids keep increasing across restarts.
    expect(service.submit("c1").id).toBe(4);
  });

  for (const crashedWhile of ["queued", "running"] as const) {
    it(`resumes once a job whose decision was saved but did not finish (${crashedWhile})`, async () => {
      const runnerA = new ControlledRunner();
      const a = boot(runnerA);
      const id = await pause(runnerA, a.service, "Borrá la rama");
      // Crash right after the decision was committed (and, for "running", after the resume started).
      const store = new SqliteJobStore(a.db);
      store.transition(id, "needs_approval", { status: "queued", decision: { approved: true, note: "dale" } });
      if (crashedWhile === "running") store.update(id, { status: "running" });
      a.db.close();

      const runnerB = new ControlledRunner();
      const { service } = boot(runnerB);
      const done = nextEvent(service, "done");
      expect(service.recover()).toEqual({ pending: [], requeued: [], rerun: [], resumed: [id] });
      expect(await done).toMatchObject({ id, answer: "aprobado" });
      expect(runnerB.resumes).toEqual([{ threadId: `job-${id}`, decision: { approved: true, note: "dale" } }]);
      expect(runnerB.asks.size).toBe(0);
      expect(service.approve(id)).toBe("not_pending");
    });
  }

  it("keeps finished jobs and conversation memory across a restart", async () => {
    const runnerA = new ControlledRunner();
    const a = boot(runnerA);
    a.service.submit("q1", { requester: "ana" });
    await runnerA.release("q1", answered("r1"));
    await a.service.idle();
    a.db.close();

    const runnerB = new ControlledRunner();
    const { service } = boot(runnerB);
    expect(service.recover()).toEqual({ pending: [], requeued: [], rerun: [], resumed: [] });
    expect(service.status(1)).toMatchObject({ status: "done", answer: "r1", requester: "ana" });
    expect(service.submit("q2", { requester: "ana" }).id).toBe(2);
    await waitFor(() => runnerB.asks.has("q2"));
    expect(runnerB.histories.get("q2")?.map((t) => t.question)).toEqual(["q1"]);
  });
});

describe("AssistantService restart with the real graph (fake LLM)", () => {
  it("pauses in one process and resumes in another, writing the pending entry once", async () => {
    const llm: Llm = async (system) => {
      if (system === ROUTER_PROMPT) return '{"route":"sensitive","topic":"ramas","reason":"test"}';
      if (system === DRAFT_PROMPT) return "Borrador: lo hace una persona.";
      throw new Error("unexpected prompt");
    };
    const embedder = new FakeEmbedder();
    const pending = new PendingStore(join(dir, "pending.json"));
    const runnerOver = (db: DatabaseSync) =>
      graphRunner(
        buildGraph(
          { llm, retriever: new Retriever({ model: embedder.model, createdAt: "", chunks: [] }, embedder, { docSlots: 2, minScore: 0.5 }), tools: new MockToolProvider(), pending },
          new SqliteCheckpointSaver(db),
        ),
      );

    const dbA = open();
    const serviceA = new AssistantService(runnerOver(dbA), { jobs: new SqliteJobStore(dbA) });
    const approval = nextEvent(serviceA, "needs_approval");
    const { id } = serviceA.submit("Borrá la rama release/0.9");
    expect((await approval).draft).toBe("Borrador: lo hace una persona.");
    await serviceA.idle();
    dbA.close();

    const dbB = open();
    const serviceB = new AssistantService(runnerOver(dbB), { jobs: new SqliteJobStore(dbB) });
    expect(serviceB.recover().pending).toEqual([id]);
    const done = nextEvent(serviceB, "done");
    expect(serviceB.approve(id)).toBe("accepted");
    expect((await done).answer).toContain("aprobó");
    expect(serviceB.approve(id)).toBe("not_pending");
    expect(await pending.list()).toMatchObject([{ reason: "escalated", decision: "approved" }]);
    expect(await pending.list()).toHaveLength(1);
  });
});
