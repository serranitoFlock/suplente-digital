import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, hasAnthropicCredentials } from "../src/config.js";
import { askAgent, buildGraph, resumeAgent } from "../src/graph/graph.js";
import type { Route } from "../src/graph/state.js";
import { createClaudeLlm } from "../src/llm.js";
import { PendingStore } from "../src/pending/store.js";
import { LocalE5Embedder } from "../src/rag/embeddings.js";
import { Retriever } from "../src/rag/retriever.js";
import { MockToolProvider } from "../src/tools/mock-provider.js";

interface EvalCase {
  id: string;
  question: string;
  expectedRoute: Route;
  expectedFacts: string[];
  mustSayNoSe?: boolean;
}

const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

async function main(): Promise<void> {
  if (!hasAnthropicCredentials()) {
    console.error("Eval requires ANTHROPIC_API_KEY (copy .env.example to .env). No requests were made.");
    process.exit(1);
  }

  const cases = JSON.parse(await readFile(new URL("./questions.json", import.meta.url), "utf8")) as EvalCase[];
  const tmp = await mkdtemp(join(tmpdir(), "suplente-eval-"));
  const retriever = await Retriever.load(
    config.indexPath,
    new LocalE5Embedder(config.embeddingModel, config.transformersCacheDir),
    config.retrieval,
  );
  // Mock tools and an isolated pending log keep eval runs reproducible and side-effect free.
  const graph = buildGraph({
    llm: createClaudeLlm(config.model),
    retriever,
    tools: new MockToolProvider(),
    pending: new PendingStore(join(tmp, "pending.json")),
  });

  const rows = [];
  try {
    for (const testCase of cases) {
      let turn = await askAgent(graph, testCase.question, `eval-${testCase.id}`);
      const escalated = Boolean(turn.review);
      if (turn.review) turn = await resumeAgent(graph, { approved: false, note: "eval" }, `eval-${testCase.id}`);

      // Score only the reply body, not the appended source list (file names would inflate hits).
      const answer = normalize((turn.state.answer ?? "").split("\n\nFuentes:")[0]!);
      const hits = testCase.expectedFacts.filter((fact) => answer.includes(normalize(fact))).length;
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
      });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.table(rows.map(({ factRate: _factRate, ...row }) => row));
  const pct = (values: boolean[]) => (values.length ? `${Math.round((100 * values.filter(Boolean).length) / values.length)}%` : "n/a");
  const factRates = rows.flatMap((r) => (r.factRate === undefined ? [] : [r.factRate]));
  console.log(`Route accuracy:      ${pct(rows.map((r) => r.routeOk))}`);
  console.log(`Fact hit rate:       ${factRates.length ? `${Math.round((100 * factRates.reduce((a, b) => a + b, 0)) / factRates.length)}%` : "n/a"}`);
  console.log(`Correct "no sé":     ${pct(rows.flatMap((r) => (r.noSeOk === undefined ? [] : [r.noSeOk])))}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
