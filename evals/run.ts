import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, loadCostRates, loadLlmSettings } from "../src/config.js";
import { askAgent, buildGraph, resumeAgent, tracedTurn } from "../src/graph/graph.js";
import type { Route } from "../src/graph/state.js";
import { createLlm, describeLlm } from "../src/llm.js";
import { computeStats, formatUsd } from "../src/observability/stats.js";
import { JsonlTraceExporter, Tracer, type TraceSummary } from "../src/observability/tracing.js";
import { PendingStore } from "../src/pending/store.js";
import { LocalE5Embedder } from "../src/rag/embeddings.js";
import { Retriever } from "../src/rag/retriever.js";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import { countFacts, injectionResisted, mergeSummaries } from "./scoring.js";

interface EvalCase {
  id: string;
  question: string;
  expectedRoute: Route;
  expectedFacts: string[];
  mustSayNoSe?: boolean;
  /** Adversarial cases: strings that must never appear in the reply or draft (canary, exfil host, prompt fragments). */
  mustNotContain?: string[];
}

async function main(): Promise<void> {
  // Throws a readable error (missing LLM_MODEL / ANTHROPIC_API_KEY) before any request is made.
  const llmSettings = loadLlmSettings();
  console.log(`Eval model: ${describeLlm(llmSettings)}`);

  const cases = JSON.parse(await readFile(new URL("./questions.json", import.meta.url), "utf8")) as EvalCase[];
  const tmp = await mkdtemp(join(tmpdir(), "suplente-eval-"));
  const retriever = await Retriever.load(
    config.indexPath,
    new LocalE5Embedder(config.embeddingModel, config.transformersCacheDir),
    config.retrieval,
  );
  // Mock tools and an isolated pending log keep eval runs reproducible and side-effect free.
  const graph = buildGraph({
    llm: createLlm(llmSettings),
    retriever,
    tools: new MockToolProvider(),
    pending: new PendingStore(join(tmp, "pending.json")),
    allowedLinkHosts: config.security.allowedLinkHosts,
  });

  const tracer = new Tracer({ exporters: [new JsonlTraceExporter(config.tracesPath)], costRates: loadCostRates() });
  const caseSummaries: TraceSummary[] = [];
  const rows = [];
  try {
    for (const testCase of cases) {
      const threadId = `eval-${testCase.id}`;
      const tracesBefore = tracer.summaries.length;
      let turn = await tracedTurn(tracer, threadId, "ask", () => askAgent(graph, testCase.question, threadId));
      const escalated = Boolean(turn.review);
      if (turn.review) turn = await tracedTurn(tracer, threadId, "resume", () => resumeAgent(graph, { approved: false, note: "eval" }, threadId));
      // An escalated case is two traces (ask + resume); count it as one request.
      const caseSummary = mergeSummaries(tracer.summaries.slice(tracesBefore));
      caseSummaries.push(caseSummary);

      // Score only the reply body, not the appended source list (file names would inflate hits).
      const hits = countFacts((turn.state.answer ?? "").split("\n\nFuentes:")[0]!, testCase.expectedFacts);
      const saidNoSe = turn.state.outcome === "unknown";
      rows.push({
        id: testCase.id,
        expected: testCase.expectedRoute,
        got: turn.state.route,
        routeOk: turn.state.route === testCase.expectedRoute,
        facts: testCase.expectedFacts.length ? `${hits}/${testCase.expectedFacts.length}` : "-",
        factRate: testCase.expectedFacts.length ? hits / testCase.expectedFacts.length : undefined,
        noSeOk: testCase.mustSayNoSe ? saidNoSe : testCase.expectedRoute === "question" ? !saidNoSe : undefined,
        escalated,
        ms: caseSummary.durationMs,
        tokens: caseSummary.usageReported ? caseSummary.inputTokens + caseSummary.outputTokens : "n/a",
        injectionOk: testCase.mustNotContain ? injectionResisted([turn.state.answer, turn.state.draft], testCase.mustNotContain) : undefined,
      });
    }
  } finally {
    await tracer.flush();
    await rm(tmp, { recursive: true, force: true });
  }

  console.table(rows.map(({ factRate: _factRate, ...row }) => row));
  const pct = (values: boolean[]) => (values.length ? `${Math.round((100 * values.filter(Boolean).length) / values.length)}%` : "n/a");
  const factRates = rows.flatMap((r) => (r.factRate === undefined ? [] : [r.factRate]));
  console.log(`Route accuracy:      ${pct(rows.map((r) => r.routeOk))}`);
  console.log(`Fact hit rate:       ${factRates.length ? `${Math.round((100 * factRates.reduce((a, b) => a + b, 0)) / factRates.length)}%` : "n/a"}`);
  console.log(`Correct "no sé":     ${pct(rows.flatMap((r) => (r.noSeOk === undefined ? [] : [r.noSeOk])))}`);
  console.log(`Injection resisted:  ${pct(rows.flatMap((r) => (r.injectionOk === undefined ? [] : [r.injectionOk])))}`);

  const stats = computeStats(caseSummaries);
  const secs = (ms: number | undefined) => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
  const avg = (value: number | undefined) => (value === undefined ? "n/a" : Math.round(value).toString());
  console.log(`Latency per case:    p50 ${secs(stats.p50Ms)} · p95 ${secs(stats.p95Ms)}`);
  console.log(`Avg tokens per case: in ${avg(stats.avgInputTokens)} · out ${avg(stats.avgOutputTokens)} (usage reported for ${stats.withUsage}/${stats.requests} cases)`);
  console.log(`Estimated cost:      ${formatUsd(stats.totalCostUsd)} total (LLM_COST_INPUT_PER_MTOK / LLM_COST_OUTPUT_PER_MTOK)`);
  console.log(`Traces:              ${config.tracesPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
