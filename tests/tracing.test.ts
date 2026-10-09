import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANSWER_PROMPT } from "../src/graph/answer.js";
import { askAgent, buildGraph, tracedTurn } from "../src/graph/graph.js";
import { ROUTER_PROMPT } from "../src/graph/router.js";
import { tracedLlm } from "../src/llm.js";
import { computeStats, percentile, renderStats } from "../src/observability/stats.js";
import {
  InMemoryTraceExporter,
  JsonlTraceExporter,
  Tracer,
  estimateCost,
  resolveCostRates,
  withSpan,
} from "../src/observability/tracing.js";
import { PendingStore } from "../src/pending/store.js";
import { buildIndexFromDocs } from "../src/rag/ingest.js";
import { Retriever } from "../src/rag/retriever.js";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";

/** Fake clock: every reading advances 10 ms. */
const fakeClock = () => {
  let now = 1_000;
  return () => (now += 10);
};

describe("Tracer", () => {
  it("records nested spans with parents, clock-based durations and one export per trace", async () => {
    const exporter = new InMemoryTraceExporter();
    const tracer = new Tracer({ exporters: [exporter], clock: fakeClock() });
    const { result, trace } = await tracer.trace("root", { "app.kind": "test" }, async () =>
      withSpan("child", {}, async () => withSpan("grandchild", { x: 1 }, async () => 42)),
    );
    expect(result).toBe(42);
    expect(exporter.traces).toEqual([trace]);
    const [root, child, grandchild] = ["root", "child", "grandchild"].map((n) => trace.spans.find((s) => s.name === n)!);
    expect(root!.parentSpanId).toBeUndefined();
    expect(child!.parentSpanId).toBe(root!.spanId);
    expect(grandchild!.parentSpanId).toBe(child!.spanId);
    expect(new Set(trace.spans.map((s) => s.traceId))).toEqual(new Set([trace.traceId]));
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(grandchild!.durationMs).toBe(10);
    expect(root!.durationMs).toBe(50);
    expect(trace.durationMs).toBe(50);
  });

  it("marks failed spans, still exports the trace and rethrows", async () => {
    const exporter = new InMemoryTraceExporter();
    const tracer = new Tracer({ exporters: [exporter], clock: fakeClock() });
    await expect(tracer.trace("root", {}, () => withSpan("boom", {}, async () => Promise.reject(new Error("kaput"))))).rejects.toThrow("kaput");
    const spans = exporter.traces[0]!.spans;
    expect(spans.find((s) => s.name === "boom")).toMatchObject({ status: "error", error: "kaput" });
    expect(spans.find((s) => s.name === "root")).toMatchObject({ status: "error" });
  });

  it("runs spans as no-ops outside a trace", async () => {
    expect(await withSpan("orphan", {}, async () => "ok")).toBe("ok");
  });
});

describe("tracedLlm", () => {
  it("adds an OTel GenAI chat span with token usage when the model reports it", async () => {
    const tracer = new Tracer({ clock: fakeClock(), costRates: { inputPerMTok: 3, outputPerMTok: 15 } });
    const llm = tracedLlm({ provider: "openai-compatible", model: "bonsai", serverAddress: "localhost" }, async () => ({
      text: "hola",
      usage: { inputTokens: 1_000, outputTokens: 200 },
    }));
    const { trace } = await tracer.trace("root", {}, () => llm("sys", "user"));
    expect(trace.spans.find((s) => s.name === "chat bonsai")!.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai-compatible",
      "gen_ai.request.model": "bonsai",
      "gen_ai.usage.input_tokens": 1_000,
      "gen_ai.usage.output_tokens": 200,
      "server.address": "localhost",
    });
    expect(trace.summary).toMatchObject({ llmCalls: 1, inputTokens: 1_000, outputTokens: 200, usageReported: true });
    expect(trace.summary.costUsd).toBeCloseTo(0.003 + 0.003);
  });

  it("handles a model that reports no usage", async () => {
    const tracer = new Tracer({ clock: fakeClock() });
    const llm = tracedLlm({ provider: "openai-compatible", model: "bonsai" }, async () => ({ text: "hola" }));
    const { trace } = await tracer.trace("root", {}, () => llm("sys", "user"));
    expect(trace.spans.find((s) => s.name === "chat bonsai")!.attributes).not.toHaveProperty("gen_ai.usage.input_tokens");
    expect(trace.summary).toMatchObject({ llmCalls: 1, inputTokens: 0, outputTokens: 0, usageReported: false, costUsd: 0 });
  });
});

describe("cost", () => {
  it("estimates cost from per-million-token rates", () => {
    expect(estimateCost({ inputTokens: 2_000_000, outputTokens: 500_000 }, { inputPerMTok: 1, outputPerMTok: 4 })).toBe(4);
  });

  it("defaults rates to 0 (local model) and rejects invalid values", () => {
    expect(resolveCostRates({})).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
    expect(resolveCostRates({ LLM_COST_INPUT_PER_MTOK: "0.5", LLM_COST_OUTPUT_PER_MTOK: "2" })).toEqual({ inputPerMTok: 0.5, outputPerMTok: 2 });
    expect(() => resolveCostRates({ LLM_COST_INPUT_PER_MTOK: "-1" })).toThrow(/LLM_COST_INPUT_PER_MTOK/);
  });
});

describe("graph tracing (fake LLM, fake embeddings)", () => {
  it("emits one trace per request with node, chat and route attributes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-"));
    try {
      const embedder = new FakeEmbedder();
      const index = await buildIndexFromDocs(
        [{ source: "cdn.md", markdown: "# CDN\n\n## Manifiesto\n\nEl manifiesto de versiones del CDN define qué bundle carga cada componente." }],
        embedder,
      );
      const llm = tracedLlm({ provider: "fake", model: "fake-model" }, async (system) => ({
        text: system === ROUTER_PROMPT ? '{"route":"question","topic":"cdn"}' : system === ANSWER_PROMPT ? "Lo define el manifiesto [1]." : "?",
        usage: { inputTokens: 100, outputTokens: 10 },
      }));
      const graph = buildGraph({
        llm,
        retriever: new Retriever(index, embedder, { topK: 2, minScore: 0.3 }),
        tools: new MockToolProvider(),
        pending: new PendingStore(join(dir, "pending.json")),
      });
      const exporter = new InMemoryTraceExporter();
      const tracer = new Tracer({ exporters: [exporter], clock: fakeClock() });

      const turn = await tracedTurn(tracer, "thread-1", "ask", () => askAgent(graph, "¿Qué bundle carga el manifiesto del CDN?", "thread-1"));
      expect(turn.state.outcome).toBe("answered");

      const [trace] = exporter.traces;
      const names = trace!.spans.map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(["invoke_agent suplente-digital", "node router", "node rag_answer", "chat fake-model"]));
      const byId = new Map(trace!.spans.map((s) => [s.spanId, s]));
      const chatParents = trace!.spans.filter((s) => s.name === "chat fake-model").map((s) => byId.get(s.parentSpanId!)!.name);
      expect(chatParents.sort()).toEqual(["node rag_answer", "node router"]);
      expect(trace!.spans[0]!.attributes).toMatchObject({
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.conversation.id": "thread-1",
        "app.route": "question",
        "app.outcome": "answered",
      });
      expect(trace!.summary).toMatchObject({ route: "question", llmCalls: 2, inputTokens: 200, outputTokens: 20 });
      expect(JSON.stringify(trace)).not.toContain("manifiesto del CDN"); // no prompt/question content in traces
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("JsonlTraceExporter", () => {
  it("appends one JSON line per trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jsonl-"));
    try {
      const path = join(dir, "nested", "traces.jsonl");
      const tracer = new Tracer({ exporters: [new JsonlTraceExporter(path)], clock: fakeClock() });
      await tracer.trace("a", {}, async () => 1);
      await tracer.trace("b", {}, async () => 2);
      await tracer.flush();
      const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((t) => t.name)).toEqual(["a", "b"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stats", () => {
  it("computes nearest-rank percentiles", () => {
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(values, 50)).toBe(500);
    expect(percentile(values, 95)).toBe(1000);
    expect(percentile([], 50)).toBeUndefined();
  });

  it("aggregates latency, tokens and cost across requests", () => {
    const base = { traceId: "t", name: "x", llmCalls: 2 };
    const stats = computeStats([
      { ...base, durationMs: 1000, inputTokens: 100, outputTokens: 10, usageReported: true, costUsd: 0.01 },
      { ...base, durationMs: 3000, inputTokens: 300, outputTokens: 30, usageReported: true, costUsd: 0.03 },
      { ...base, durationMs: 2000, inputTokens: 0, outputTokens: 0, usageReported: false, costUsd: 0 },
    ]);
    expect(stats).toMatchObject({ requests: 3, p50Ms: 2000, p95Ms: 3000, withUsage: 2, avgInputTokens: 200, avgOutputTokens: 20, totalCostUsd: 0.04 });
    expect(renderStats(stats)).toMatch(/p50/);
    expect(renderStats(computeStats([]))).toMatch(/Todavía no hay consultas/);
  });
});
