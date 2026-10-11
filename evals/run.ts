import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config, loadCostRates, loadLlmSettings } from "../src/config.js";
import { askAgent, buildGraph, resumeAgent, tracedTurn } from "../src/graph/graph.js";
import type { ConversationTurn, Route } from "../src/graph/state.js";
import { createLlm, describeLlm } from "../src/llm.js";
import { toConversationTurn } from "../src/memory/conversation-memory.js";
import { computeStats, formatUsd } from "../src/observability/stats.js";
import { JsonlTraceExporter, Tracer, type TraceSummary } from "../src/observability/tracing.js";
import { PendingStore } from "../src/pending/store.js";
import { LocalE5Embedder } from "../src/rag/embeddings.js";
import { contextShare, mean, recallAtK, reciprocalRank } from "../src/rag/metrics.js";
import { Retriever, type VectorIndex } from "../src/rag/retriever.js";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import { withScripts } from "../src/tools/script-provider.js";
import { loadScriptRegistry } from "../src/tools/scripts.js";
import { parseEvalArgs, selectCases } from "./options.js";
import { calledNoTool, countFacts, injectionResisted, mergeSummaries, passRates, runChecks } from "./scoring.js";

interface EvalCase {
  id: string;
  question: string;
  expectedRoute: Route;
  expectedFacts: string[];
  mustSayNoSe?: boolean;
  /** Adversarial cases: strings that must never appear in the reply or draft (canary, exfil host, prompt fragments). */
  mustNotContain?: string[];
  /** Knowledge files that should be retrieved for this question (retrieval metrics). */
  expectedSources?: string[];
  /**
   * Multi-turn cases: earlier user messages of the same conversation, run through the graph first
   * (their turns become the short-term memory of `question`). Not scored themselves.
   */
  conversation?: string[];
  /** Multi-turn cases: a fixed history instead of (or before) `conversation`. */
  history?: ConversationTurn[];
  /** No live tool may run (a clarification instead of an invented id, a write request that must escalate). */
  mustNotCallTools?: boolean;
  /** Why an expectation changed (kept next to the case so spec changes are visible, not silent). */
  note?: string;
  /** Strings the reply must not mention (e.g. an unrelated ticket a wrong follow-up would invent). */
  mustNotMention?: string[];
  /** Sources that filters must keep out of the index (e.g. superseded or personal Engram notes); also checks `mustNotMention`. */
  excludedSources?: string[];
}

const isMultiTurn = (c: EvalCase) => Boolean(c.conversation?.length || c.history?.length || c.expectedRoute === "clarify");

const pctOf = (value: number | undefined) => (value === undefined ? "n/a" : `${Math.round(100 * value)}%`);

/**
 * Retriever-only pass, before any generation: recall@k and MRR over the cases with `expectedSources`
 * rank the whole index (no `minScore` cut-off) so they isolate ranking quality; context share looks at
 * the source-balanced context actually passed to the model (`config.retrieval`).
 */
async function evaluateRetrieval(cases: EvalCase[], embedder: LocalE5Embedder): Promise<void> {
  const k = config.retrieval.docSlots;
  const ranker = await Retriever.load(config.indexPath, embedder, config.retrieval);
  const rows = [];
  for (const testCase of cases) {
    if (!testCase.expectedSources?.length) continue;
    const ranked = (await ranker.rank(testCase.question)).map((chunk) => chunk.source);
    const context = (await ranker.retrieve(testCase.question)).map((chunk) => chunk.source);
    rows.push({
      id: testCase.id,
      expected: testCase.expectedSources.join(", "),
      top1: ranked[0],
      "recall@1": recallAtK(ranked, testCase.expectedSources, 1),
      [`recall@${k}`]: recallAtK(ranked, testCase.expectedSources, k),
      rr: Number(reciprocalRank(ranked, testCase.expectedSources).toFixed(3)),
      contextShare: Number(contextShare(context, testCase.expectedSources).toFixed(2)),
    });
  }
  console.table(rows);
  console.log(`Retrieval recall@1:  ${pctOf(mean(rows.map((r) => r["recall@1"])))}`);
  console.log(`Retrieval recall@${k}:  ${pctOf(mean(rows.map((r) => r[`recall@${k}`] as number)))}`);
  console.log(`Retrieval MRR:       ${mean(rows.map((r) => r.rr))?.toFixed(3) ?? "n/a"} (${rows.length} cases with expectedSources)`);
  console.log(`Context share:       ${pctOf(mean(rows.map((r) => r.contextShare)))} (chunks passed to the model that come from the expected sources)`);

  // Guard rail for the "no sé" behavior: unanswerable questions should stay below the score cut-off.
  const { minScore } = config.retrieval;
  const unknown = [];
  for (const testCase of cases.filter((c) => c.mustSayNoSe)) {
    const [best] = await ranker.rank(testCase.question);
    unknown.push({ id: testCase.id, topScore: Number((best?.score ?? 0).toFixed(3)), aboveMinScore: (best?.score ?? 0) >= minScore });
  }
  console.log(`Unanswerable cases above minScore ${minScore}: ${unknown.filter((u) => u.aboveMinScore).length}/${unknown.length} (${unknown.map((u) => `${u.id} ${u.topScore}`).join(", ")})`);
}

/** Usage and flags (`--retrieval-only`, `--only <id,...>`, `--repeat <N>`): see evals/options.ts. */
async function main(): Promise<void> {
  const { retrievalOnly, only, repeat } = parseEvalArgs(process.argv.slice(2));
  const allCases = JSON.parse(await readFile(new URL("./questions.json", import.meta.url), "utf8")) as EvalCase[];
  // Unknown ids fail here, before the index, the embedder or the model are loaded.
  const cases = selectCases(allCases, only);
  if (only) console.log(`Cases: ${cases.length}/${allCases.length} selected (${cases.map((c) => c.id).join(", ")})`);
  const index = JSON.parse(await readFile(config.indexPath, "utf8").catch(() => {
    throw new Error(`Index not found at ${config.indexPath}. Run \`npm run ingest\` first.`);
  })) as VectorIndex;
  const indexedSources = new Set(index.chunks.map((chunk) => chunk.source));
  // Real Engram notes change what the index holds; rebuild with ENGRAM_REAL=false for reproducible runs.
  console.log(`Index: ${index.chunks.length} chunks (${Object.entries(index.composition ?? { knowledge: index.chunks.length }).map(([origin, n]) => `${origin} ${n}`).join(", ")})`);
  if ((index.composition?.["engram-real"] ?? 0) > 0) {
    console.log("Warning: the index includes real Engram notes; the expectations assume the fictional knowledge base (e.g. \"no sé\" cases may get real answers). Rebuild with ENGRAM_REAL=false npm run ingest for reproducible results.");
  }
  const embedder = new LocalE5Embedder(config.embeddingModel, config.transformersCacheDir);
  await evaluateRetrieval(cases, embedder);
  const excluded = cases.filter((c) => c.excludedSources?.length);
  const leaked = excluded.flatMap((c) => c.excludedSources!.filter((source) => indexedSources.has(source)));
  console.log(`Filtered sources indexed: ${leaked.length} (${leaked.length ? leaked.join(", ") : "none"}) across ${excluded.length} case(s)`);
  if (retrievalOnly) return;

  // Throws a readable error (missing LLM_MODEL / ANTHROPIC_API_KEY) before any request is made.
  const llmSettings = loadLlmSettings();
  console.log(`\nEval model: ${describeLlm(llmSettings)}`);
  const tmp = await mkdtemp(join(tmpdir(), "suplente-eval-"));
  const retriever = await Retriever.load(config.indexPath, embedder, config.retrieval);
  // Mock tools, the fictional demo script registry and an isolated pending log keep eval runs
  // reproducible and side-effect free (the local SCRIPTS_CONFIG is never used here).
  const scripts = await loadScriptRegistry(resolve(process.cwd(), "config/scripts.example.json"), process.cwd());
  const graph = buildGraph({
    llm: createLlm(llmSettings),
    retriever,
    tools: withScripts(new MockToolProvider(), scripts),
    pending: new PendingStore(join(tmp, "pending.json")),
    allowedLinkHosts: config.security.allowedLinkHosts,
  });

  const tracer = new Tracer({ exporters: [new JsonlTraceExporter(config.tracesPath)], costRates: loadCostRates() });
  const caseSummaries: TraceSummary[] = [];
  const rows = [];
  try {
    // Each repetition is independent: fresh thread ids, setup turns replayed, escalations rejected again.
    for (const testCase of cases) for (let run = 1; run <= repeat; run++) {
      const threadId = repeat > 1 ? `eval-${testCase.id}-r${run}` : `eval-${testCase.id}`;
      // Setup turns of a multi-turn case build its history; they are excluded from the case stats.
      let history: ConversationTurn[] = testCase.history ?? [];
      for (const [i, prior] of (testCase.conversation ?? []).entries()) {
        const priorThread = `${threadId}-turn-${i}`;
        const before = history;
        const priorTurn = await tracedTurn(tracer, priorThread, "ask", () => askAgent(graph, prior, priorThread, before));
        history = [...history, toConversationTurn(prior, priorTurn)];
      }
      const tracesBefore = tracer.summaries.length;
      let turn = await tracedTurn(tracer, threadId, "ask", () => askAgent(graph, testCase.question, threadId, history));
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
        ...(repeat > 1 ? { run } : {}),
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
        filteredOk: testCase.excludedSources?.length
          ? testCase.excludedSources.every((source) => !indexedSources.has(source)) && injectionResisted([turn.state.answer], testCase.mustNotMention ?? [])
          : undefined,
        multiTurnOk: isMultiTurn(testCase)
          ? turn.state.route === testCase.expectedRoute &&
            hits === testCase.expectedFacts.length &&
            injectionResisted([turn.state.answer], testCase.mustNotMention ?? []) &&
            (!testCase.mustNotCallTools || calledNoTool(turn.state.toolCalls))
          : undefined,
        noToolOk: testCase.mustNotCallTools ? calledNoTool(turn.state.toolCalls) : undefined,
      });
    }
  } finally {
    await tracer.flush();
    await rm(tmp, { recursive: true, force: true });
  }

  console.table(rows.map(({ factRate: _factRate, ...row }) => row));
  if (repeat > 1) {
    // Per-case stability: a run passes when every check that applies to the case holds.
    const rates = passRates(rows.map((row) => ({ id: row.id, checks: runChecks(row) })));
    console.log(`\nPass rates over ${repeat} runs per case (run passes = all applicable checks true):`);
    console.table(
      rates.map((rate) => ({
        id: rate.id,
        pass: `${rate.passed}/${rate.runs}`,
        ...Object.fromEntries(Object.entries(rate.checks).map(([name, check]) => [name, `${check.ok}/${check.runs}`])),
      })),
    );
    for (const rate of rates) console.log(`${rate.id.padEnd(28)} ${rate.passed}/${rate.runs}`);
    console.log(`Aggregate metrics below cover all ${rows.length} runs.`);
  }
  const pct = (values: boolean[]) => (values.length ? `${Math.round((100 * values.filter(Boolean).length) / values.length)}%` : "n/a");
  const factRates = rows.flatMap((r) => (r.factRate === undefined ? [] : [r.factRate]));
  console.log(`Route accuracy:      ${pct(rows.map((r) => r.routeOk))}`);
  console.log(`Fact hit rate:       ${factRates.length ? `${Math.round((100 * factRates.reduce((a, b) => a + b, 0)) / factRates.length)}%` : "n/a"}`);
  console.log(`Correct "no sé":     ${pct(rows.flatMap((r) => (r.noSeOk === undefined ? [] : [r.noSeOk])))}`);
  console.log(`Injection resisted:  ${pct(rows.flatMap((r) => (r.injectionOk === undefined ? [] : [r.injectionOk])))}`);
  console.log(`Filtered notes unused: ${pct(rows.flatMap((r) => (r.filteredOk === undefined ? [] : [r.filteredOk])))} (excluded sources not indexed, reply free of their facts)`);
  console.log(`Follow-up / clarify: ${pct(rows.flatMap((r) => (r.multiTurnOk === undefined ? [] : [r.multiTurnOk])))} (route, facts, no invented ids, no tool call when a clarification is expected)`);
  console.log(`No tool called:      ${pct(rows.flatMap((r) => (r.noToolOk === undefined ? [] : [r.noToolOk])))} (write requests and clarifications must not run any tool or script)`);

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
