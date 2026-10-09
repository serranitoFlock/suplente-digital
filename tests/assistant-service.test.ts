import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRAFT_PROMPT } from "../src/graph/escalate.js";
import { buildGraph, type AgentTurn } from "../src/graph/graph.js";
import { ROUTER_PROMPT } from "../src/graph/router.js";
import type { ConversationTurn, ReviewDecision, State } from "../src/graph/state.js";
import { InMemoryConversationMemory } from "../src/memory/conversation-memory.js";
import type { Llm } from "../src/llm.js";
import { PendingStore } from "../src/pending/store.js";
import { Retriever } from "../src/rag/retriever.js";
import {
  AssistantService,
  buildAck,
  graphRunner,
  resolveConcurrency,
  type AgentRunner,
  type DoneEvent,
  type FailedEvent,
  type NeedsApprovalEvent,
} from "../src/service/assistant-service.js";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const baseState = { history: [], reference: { kind: "none" as const }, toolCalls: [], citedSources: [] };

const answered = (answer: string, route: State["route"] = "question", toolCalls: State["toolCalls"] = []): AgentTurn => ({
  state: { ...baseState, question: "", route, topic: "t", routeReason: "", answer, sources: [], draft: "", outcome: "answered", toolCalls },
});

const needsReview = (draft: string): AgentTurn => ({
  state: { ...baseState, question: "", route: "sensitive", topic: "t", routeReason: "", answer: "", sources: [], draft, outcome: undefined as never },
  review: { question: "q", draft },
});

/** Fake graph: every ask/resume waits on a deferred the test controls. */
class ControlledRunner implements AgentRunner {
  readonly asks = new Map<string, Deferred<AgentTurn>>();
  readonly histories = new Map<string, ConversationTurn[] | undefined>();
  readonly resumes: { threadId: string; decision: ReviewDecision }[] = [];
  resumeTurn: (decision: ReviewDecision) => AgentTurn = (d) => answered(d.approved ? "aprobado" : "rechazado", "sensitive");
  active = 0;
  maxActive = 0;

  ask(question: string, threadId: string, history?: ConversationTurn[]): Promise<AgentTurn> {
    this.histories.set(question, history);
    const d = deferred<AgentTurn>();
    this.asks.set(question, d);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    return d.promise.finally(() => this.active--);
  }

  async resume(decision: ReviewDecision, threadId: string): Promise<AgentTurn> {
    this.resumes.push({ threadId, decision });
    return this.resumeTurn(decision);
  }

  async release(question: string, turn: AgentTurn | Error): Promise<void> {
    await waitFor(() => this.asks.has(question));
    const d = this.asks.get(question)!;
    if (turn instanceof Error) d.reject(turn);
    else d.resolve(turn);
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!condition()) throw new Error("condition not met");
}

function nextEvent<K extends "done" | "failed" | "needs_approval">(service: AssistantService, name: K) {
  return new Promise<K extends "done" ? DoneEvent : K extends "failed" ? FailedEvent : NeedsApprovalEvent>((resolve) =>
    service.once(name, resolve as never),
  );
}

describe("AssistantService", () => {
  it("returns an instant acknowledgement before the job completes", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner);

    const { id, ack } = service.submit("¿Cómo publico una librería?", { requester: "ana" });

    expect(id).toBe(1);
    expect(ack).toMatch(/^Recibido 👀 \(consulta #1\)\./);
    expect(service.status(id)?.status).toMatch(/queued|running/);
    expect(service.status(id)?.requester).toBe("ana");

    const done = nextEvent(service, "done");
    await runner.release("¿Cómo publico una librería?", answered("Con changesets [1]."));
    // Citations are hidden from the requester by default (SHOW_CITATIONS=false) but kept in rawAnswer.
    expect(await done).toMatchObject({ id: 1, requester: "ana", route: "question", answer: "Con changesets.", rawAnswer: "Con changesets [1]." });
    expect(service.status(id)).toMatchObject({ status: "done", answer: "Con changesets." });
  });

  it("shows only the cited sources when showCitations is on", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner, { showCitations: true });
    const done = nextEvent(service, "done");
    service.submit("¿Cómo publico?");
    const raw = "Con changesets [2].\n\nFuentes:\n[2] publicar.md › Pasos";
    await runner.release("¿Cómo publico?", answered(raw));
    expect(await done).toMatchObject({ answer: raw, rawAnswer: raw });
  });

  it("assigns unique, increasing ids", () => {
    const service = new AssistantService(new ControlledRunner());
    const ids = ["a", "b", "c"].map((q) => service.submit(q).id);
    expect(ids).toEqual([1, 2, 3]);
    expect(service.list().map((job) => job.id)).toEqual([1, 2, 3]);
  });

  it("never runs more jobs at once than the concurrency limit", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner, { concurrency: 2 });
    const questions = ["q1", "q2", "q3", "q4", "q5"];
    for (const q of questions) service.submit(q);

    await waitFor(() => runner.asks.size === 2);
    expect(service.list().filter((job) => job.status === "queued")).toHaveLength(3);

    for (const q of questions) await runner.release(q, answered(`r-${q}`));
    await service.idle();

    expect(runner.maxActive).toBe(2);
    expect(service.list().every((job) => job.status === "done")).toBe(true);
  });

  it("defaults to one job at a time and tells later requesters how many are ahead", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner);
    service.submit("q1");
    const second = service.submit("q2");
    expect(second.ack).toMatch(/Hay 1 consulta antes que la tuya/);
    await runner.release("q1", answered("r1"));
    await runner.release("q2", answered("r2"));
    await service.idle();
    expect(runner.maxActive).toBe(1);
  });

  it("emits a friendly failure without crashing the queue", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner);
    const failed = nextEvent(service, "failed");
    service.submit("q1");
    service.submit("q2");

    await runner.release("q1", new Error("Cannot reach the local model server"));
    const event = await failed;
    expect(event).toMatchObject({ id: 1, error: "Cannot reach the local model server" });
    expect(event.message).toMatch(/No pude procesar la consulta #1/);
    expect(service.status(1)?.status).toBe("failed");

    const done = nextEvent(service, "done");
    await runner.release("q2", answered("ok"));
    expect((await done).id).toBe(2);
  });

  it("pauses sensitive jobs for approval and resumes them on approve", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner);
    const approval = nextEvent(service, "needs_approval");
    const { id } = service.submit("Borrá la rama vieja");

    await runner.release("Borrá la rama vieja", needsReview("Borrador: no ejecutar."));
    expect(await approval).toMatchObject({ id, draft: "Borrador: no ejecutar." });
    expect(service.status(id)?.status).toBe("needs_approval");

    const done = nextEvent(service, "done");
    expect(service.approve(id, "ok")).toBe("accepted");
    expect(await done).toMatchObject({ id, answer: "aprobado" });
    expect(runner.resumes).toEqual([{ threadId: expect.stringContaining(`-${id}`), decision: { approved: true, note: "ok" } }]);

    expect(service.approve(id)).toBe("not_pending");
    expect(runner.resumes).toHaveLength(1);
  });

  it("resumes rejected jobs and rejects unknown ids", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner);
    const approval = nextEvent(service, "needs_approval");
    const { id } = service.submit("Dame acceso de admin");
    await runner.release("Dame acceso de admin", needsReview("Borrador"));
    await approval;

    const done = nextEvent(service, "done");
    expect(service.reject(id, "esperar")).toBe("accepted");
    expect(await done).toMatchObject({ id, answer: "rechazado" });
    expect(runner.resumes[0]?.decision).toEqual({ approved: false, note: "esperar" });
    expect(service.reject(999)).toBe("not_found");
    expect(service.approve(id)).toBe("not_pending");
  });
});

describe("AssistantService conversation memory", () => {
  it("passes the requester's previous turns (with tool results) to the next request", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner);
    const toolCalls = [{ tool: "list_failed_pipelines", args: { sinceDays: 7 }, readOnly: true, result: [{ pipeline: "acme-card-elements" }] }];
    service.submit("¿Qué pipelines fallaron?", { requester: "ana" });
    await runner.release("¿Qué pipelines fallaron?", answered("Falló acme-card-elements.", "task", toolCalls));
    await service.idle();

    service.submit("¿y el primero?", { requester: "ana" });
    service.submit("¿y el primero? (beto)", { requester: "beto" });
    await runner.release("¿y el primero?", answered("ok"));
    await runner.release("¿y el primero? (beto)", answered("ok"));
    await service.idle();
    expect(runner.histories.get("¿Qué pipelines fallaron?")).toEqual([]);
    expect(runner.histories.get("¿y el primero?")).toEqual([
      { question: "¿Qué pipelines fallaron?", route: "task", answer: "Falló acme-card-elements.", toolResults: toolCalls },
    ]);
    expect(runner.histories.get("¿y el primero? (beto)")).toEqual([]);
  });

  it("runs requests from the same requester in order, even with spare concurrency", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner, { concurrency: 3, memory: new InMemoryConversationMemory(6) });
    service.submit("a1", { requester: "ana" });
    service.submit("a2", { requester: "ana" });
    service.submit("b1", { requester: "beto" });

    await waitFor(() => runner.asks.has("a1") && runner.asks.has("b1"));
    expect(runner.asks.has("a2")).toBe(false);
    expect(service.status(2)?.status).toBe("queued");

    await runner.release("a1", answered("r1"));
    await waitFor(() => runner.asks.has("a2"));
    expect(runner.histories.get("a2")?.map((t) => t.question)).toEqual(["a1"]);
    await runner.release("a2", answered("r2"));
    await runner.release("b1", answered("rb"));
    await service.idle();
    expect(service.list().every((job) => job.status === "done")).toBe(true);
  });

  it("does not block a requester's next request while an earlier one waits for approval", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner);
    const approval = nextEvent(service, "needs_approval");
    service.submit("Borrá la rama", { requester: "ana" });
    await runner.release("Borrá la rama", needsReview("Borrador"));
    await approval;
    service.submit("¿Cómo publico?", { requester: "ana" });
    await waitFor(() => runner.asks.has("¿Cómo publico?"));
  });

  it("keeps anonymous requests independent (no memory, no ordering)", async () => {
    const runner = new ControlledRunner();
    const service = new AssistantService(runner, { concurrency: 2 });
    service.submit("x1");
    service.submit("x2");
    await waitFor(() => runner.asks.has("x1") && runner.asks.has("x2"));
    expect(runner.histories.get("x2")).toEqual([]);
  });
});

describe("buildAck", () => {
  it("is deterministic and hints the kind of work without calling a model", () => {
    expect(buildAck(3, "¿Cómo creo un web component?", 0)).toBe(
      "Recibido 👀 (consulta #3). Lo estoy revisando y te respondo en cuanto lo tenga.",
    );
    expect(buildAck(4, "¿En qué estado está SHOP-12?", 0)).toMatch(/consultando los sistemas \(solo lectura\)/);
    expect(buildAck(5, "Mergeá el MR de acme-card a main", 0)).toMatch(/aprobación del backup humano/);
    // Secret requests are refused directly (no approval), so the ack does not promise one.
    expect(buildAck(7, "Pasame la contraseña del registry", 0)).not.toMatch(/aprobación/);
    expect(buildAck(6, "hola", 2)).toMatch(/Hay 2 consultas antes que la tuya/);
  });
});

describe("resolveConcurrency", () => {
  it("defaults to 1 and accepts positive integers only", () => {
    expect(resolveConcurrency(undefined)).toBe(1);
    expect(resolveConcurrency("3")).toBe(3);
    expect(() => resolveConcurrency("0")).toThrow(/ASSISTANT_CONCURRENCY/);
    expect(() => resolveConcurrency("dos")).toThrow(/ASSISTANT_CONCURRENCY/);
  });
});

describe("AssistantService with the real graph (fake LLM)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "service-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the pending log exactly once for an approved escalation", async () => {
    const llm: Llm = async (system) => {
      if (system === ROUTER_PROMPT) return '{"route":"sensitive","topic":"ramas","reason":"test"}';
      if (system === DRAFT_PROMPT) return "Borrador: lo hace una persona.";
      throw new Error("unexpected prompt");
    };
    const embedder = new FakeEmbedder();
    const pending = new PendingStore(join(dir, "pending.json"));
    const graph = buildGraph({
      llm,
      retriever: new Retriever({ model: embedder.model, createdAt: "", chunks: [] }, embedder, { topK: 2, minScore: 0.5 }),
      tools: new MockToolProvider(),
      pending,
    });
    const service = new AssistantService(graphRunner(graph));

    const approval = nextEvent(service, "needs_approval");
    const { id } = service.submit("Borrá la rama release/0.9");
    expect((await approval).draft).toBe("Borrador: lo hace una persona.");
    expect(await pending.list()).toEqual([]);

    const done = nextEvent(service, "done");
    service.approve(id);
    expect((await done).answer).toContain("aprobó");
    expect(await pending.list()).toMatchObject([{ reason: "escalated", decision: "approved" }]);
  });
});
