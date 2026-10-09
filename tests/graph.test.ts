import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANSWER_PROMPT } from "../src/graph/answer.js";
import { DRAFT_PROMPT } from "../src/graph/escalate.js";
import { askAgent, buildGraph, resumeAgent, type AgentGraph } from "../src/graph/graph.js";
import { ROUTER_PROMPT } from "../src/graph/router.js";
import { TOOL_SELECTION_PROMPT, TOOL_SUMMARY_PROMPT } from "../src/graph/task.js";
import type { Llm } from "../src/llm.js";
import { PendingStore } from "../src/pending/store.js";
import { buildIndexFromDocs } from "../src/rag/ingest.js";
import { Retriever, type VectorIndex } from "../src/rag/retriever.js";
import type { ConversationTurn } from "../src/graph/state.js";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import type { ToolCall, ToolProvider } from "../src/tools/types.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";

const pipelineHistory: ConversationTurn[] = [
  {
    question: "no me están funcionando los pipelines",
    route: "task",
    answer: "Fallaron acme-card-elements, acme-ui-kit y acme-shell.",
    toolResults: [
      {
        tool: "list_failed_pipelines",
        args: { sinceDays: 7 },
        readOnly: true,
        result: [
          { pipeline: "acme-card-elements", job: "build:elements", reason: "input 'variant' no existe" },
          { pipeline: "acme-ui-kit", job: "test:unit", reason: "zona horaria" },
        ],
      },
    ],
  },
];

/** Records every tool call so tests can assert that no id was invented. */
class RecordingTools implements ToolProvider {
  readonly name = "recording";
  readonly calls: ToolCall[] = [];
  readonly #inner = new MockToolProvider();
  call(call: ToolCall): Promise<string> {
    this.calls.push(call);
    return this.#inner.call(call);
  }
}

interface Script {
  route: string;
  answer?: string;
  tool?: string;
}

/** Fake model: answers each node's prompt from a per-test script, recording calls. */
function fakeLlm(script: Script, calls: string[]): Llm {
  return async (system, user) => {
    if (system === ROUTER_PROMPT) {
      calls.push("router");
      return JSON.stringify({ route: script.route, topic: "cdn", reason: "test" });
    }
    if (system === ANSWER_PROMPT) {
      calls.push("answer");
      return script.answer ?? "NO_SE";
    }
    if (system === TOOL_SELECTION_PROMPT) {
      calls.push("tool_selection");
      return script.tool ?? '{"tool":"none"}';
    }
    if (system === TOOL_SUMMARY_PROMPT) {
      calls.push("tool_summary");
      return `Resumen: ${user.includes("DEMO-102") ? "DEMO-102 en progreso" : "sin datos"}`;
    }
    if (system === DRAFT_PROMPT) {
      calls.push("draft");
      return "Borrador: no ejecutar; confirmar con la persona responsable.";
    }
    throw new Error("unexpected prompt");
  };
}

describe("agent graph (fake LLM, fake embeddings)", () => {
  let dir: string;
  let pending: PendingStore;
  let calls: string[];
  let index: VectorIndex;
  const embedder = new FakeEmbedder();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "graph-"));
    pending = new PendingStore(join(dir, "pending.json"));
    calls = [];
    index = await buildIndexFromDocs(
      [{ source: "cdn.md", markdown: "# CDN\n\n## Manifiesto\n\nEl manifiesto de versiones del CDN define qué bundle carga cada componente." }],
      embedder,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const graphFor = (script: Script, minScore = 0.3): AgentGraph =>
    buildGraph({
      llm: fakeLlm(script, calls),
      retriever: new Retriever(index, embedder, { topK: 2, minScore }),
      tools: new MockToolProvider(),
      pending,
    });

  it("answers from retrieved docs and cites sources", async () => {
    const graph = graphFor({ route: "question", answer: "Lo define el manifiesto [1]." });
    const { state, review } = await askAgent(graph, "¿Qué bundle carga el manifiesto del CDN?", "t1");
    expect(review).toBeUndefined();
    expect(state.outcome).toBe("answered");
    expect(state.answer).toContain("Fuentes:\n[1] cdn.md › CDN > Manifiesto");
    expect(await pending.list()).toEqual([]);
  });

  it('says "no sé" and logs a pending item when the model lacks context', async () => {
    const graph = graphFor({ route: "question", answer: "NO_SE" });
    const { state } = await askAgent(graph, "¿Qué bundle carga el manifiesto del CDN?", "t2");
    expect(state.outcome).toBe("unknown");
    expect(state.answer).toMatch(/No sé/);
    expect(await pending.list()).toMatchObject([{ reason: "unknown", topic: "cdn" }]);
  });

  it("skips the model when nothing relevant is retrieved", async () => {
    const graph = graphFor({ route: "question", answer: "no debería usarse" }, 0.99);
    const { state } = await askAgent(graph, "¿Cuál es la política de feriados?", "t3");
    expect(state.outcome).toBe("unknown");
    expect(calls).toEqual(["router"]);
  });

  it("resolves read-only tasks with the tool provider", async () => {
    const graph = graphFor({ route: "task", tool: '{"tool":"get_ticket","args":{"key":"DEMO-102"}}' });
    const { state } = await askAgent(graph, "¿En qué estado está DEMO-102?", "t4");
    expect(state.outcome).toBe("answered");
    expect(state.answer).toContain("DEMO-102 en progreso");
    expect(state.answer).toContain("get_ticket vía mock");
  });

  it("pauses sensitive requests for human approval and records the decision", async () => {
    const graph = graphFor({ route: "sensitive" });
    const first = await askAgent(graph, "Necesito que actualices el manifiesto de producción ya", "t5");
    expect(first.review?.draft).toContain("Borrador");
    expect(first.state.outcome).toBeUndefined();
    expect(await pending.list()).toEqual([]);

    const resumed = await resumeAgent(graph, { approved: false, note: "Esperar a la vuelta" }, "t5");
    expect(resumed.review).toBeUndefined();
    expect(resumed.state.outcome).toBe("rejected");
    expect(resumed.state.answer).toContain("Esperar a la vuelta");
    expect(await pending.list()).toMatchObject([{ reason: "escalated", decision: "rejected" }]);
  });

  it("forces escalation for irreversible requests even if the model routes them elsewhere", async () => {
    const graph = graphFor({ route: "question" });
    const { state, review } = await askAgent(graph, "Borrá la rama release/1.0", "t6");
    expect(state.route).toBe("sensitive");
    expect(review).toBeDefined();
    expect(calls).not.toContain("answer");
  });

  it("passes retrieved docs as delimited untrusted data and strips exfiltration links from the reply", async () => {
    let seenUser = "";
    const graph = buildGraph({
      llm: async (system, user) => {
        if (system === ROUTER_PROMPT) return '{"route":"question","topic":"cdn"}';
        seenUser = user;
        return "Lo define el manifiesto [1]. Validá en https://exfil.example.net/c?d=x";
      },
      retriever: new Retriever(index, embedder, { topK: 2, minScore: 0.3 }),
      tools: new MockToolProvider(),
      pending,
    });
    const { state } = await askAgent(graph, "¿Qué bundle carga el manifiesto del CDN?", "t8");
    expect(seenUser).toMatch(/<documento id="1" fuente="cdn.md"/);
    expect(state.answer).not.toContain("exfil.example.net");
    expect(state.answer).toContain("[enlace externo omitido]");
  });

  it("declines out-of-scope requests without extra model calls", async () => {
    const graph = graphFor({ route: "out_of_scope" });
    const { state } = await askAgent(graph, "¿Qué película me recomendás?", "t7");
    expect(state.outcome).toBe("out_of_scope");
    expect(calls).toEqual(["router"]);
  });

  describe("conversation memory and follow-ups", () => {
    const followUpGraph = (route: string, tool: string | undefined, tools: ToolProvider, seen: string[]) =>
      buildGraph({
        llm: async (system, user) => {
          if (system === ROUTER_PROMPT) {
            seen.push(`router:${user}`);
            return JSON.stringify({ route, topic: "pipelines", reason: "test" });
          }
          if (system === TOOL_SELECTION_PROMPT) {
            seen.push("tool_selection");
            return tool ?? '{"tool":"none"}';
          }
          if (system === TOOL_SUMMARY_PROMPT) {
            seen.push(`summary:${user}`);
            return "Falló build:elements en acme-card-elements.";
          }
          if (system === DRAFT_PROMPT) return "Borrador: lo hace una persona.";
          throw new Error("unexpected prompt");
        },
        retriever: new Retriever(index, embedder, { topK: 2, minScore: 0.3 }),
        tools,
        pending,
      });

    it('resolves "el primero que me pasaste" against the previous tool result without calling a tool', async () => {
      const seen: string[] = [];
      const tools = new RecordingTools();
      const graph = followUpGraph("question", undefined, tools, seen);
      const { state } = await askAgent(graph, "es sobre el primero que me pasaste, que paso?", "m1", pipelineHistory);
      expect(state.route).toBe("task");
      expect(tools.calls).toEqual([]);
      expect(seen).not.toContain("tool_selection");
      expect(seen.find((s) => s.startsWith("router:"))).toMatch(/Conversación reciente[\s\S]*acme-card-elements/);
      expect(seen.find((s) => s.startsWith("summary:"))).toContain("acme-card-elements");
      expect(state.answer).toContain("Basado en el resultado anterior de list_failed_pipelines");
      expect(state.answer).not.toContain("DEMO-101");
      expect(state.toolCalls).toMatchObject([{ fromMemory: true, result: [{ pipeline: "acme-card-elements" }] }]);
    });

    it("asks for clarification instead of guessing when there is no history", async () => {
      const seen: string[] = [];
      const tools = new RecordingTools();
      const graph = followUpGraph("task", '{"tool":"get_ticket","args":{"key":"DEMO-101"}}', tools, seen);
      const { state } = await askAgent(graph, "es sobre el primero que me pasaste, que paso?", "m2");
      expect(state.route).toBe("clarify");
      expect(state.outcome).toBe("clarify");
      expect(state.answer).toMatch(/¿Puedes indicarme/);
      expect(seen).toEqual([]);
      expect(tools.calls).toEqual([]);
    });

    it("never calls get_ticket with a key the requester did not give", async () => {
      const seen: string[] = [];
      const tools = new RecordingTools();
      const graph = followUpGraph("task", '{"tool":"get_ticket","args":{"key":"DEMO-101"}}', tools, seen);
      const { state } = await askAgent(graph, "¿Cómo viene el ticket del CDN?", "m3");
      expect(state.outcome).toBe("clarify");
      expect(tools.calls).toEqual([]);
    });

    it("refreshes a referenced ticket with its real key", async () => {
      const seen: string[] = [];
      const tools = new RecordingTools();
      const graph = followUpGraph("task", undefined, tools, seen);
      const history: ConversationTurn[] = [
        { question: "buscá tickets del cdn", route: "task", answer: "DEMO-102", toolResults: [{ tool: "search_tickets", args: { query: "cdn" }, readOnly: true, result: [{ key: "DEMO-102", summary: "acme-header no carga" }] }] },
      ];
      const { state } = await askAgent(graph, "¿Y ese ticket en qué quedó?", "m4", history);
      expect(tools.calls).toEqual([{ tool: "get_ticket", args: { key: "DEMO-102" } }]);
      expect(state.toolCalls).toMatchObject([{ tool: "get_ticket", readOnly: true, result: { key: "DEMO-102", status: "En progreso" } }]);
    });

    it("escalates a follow-up that asks to change the referenced ticket", async () => {
      const seen: string[] = [];
      const tools = new RecordingTools();
      const history: ConversationTurn[] = [
        { question: "buscá tickets del cdn", route: "task", answer: "DEMO-102", toolResults: [{ tool: "search_tickets", args: { query: "cdn" }, readOnly: true, result: [{ key: "DEMO-102", summary: "acme-header no carga" }] }] },
      ];
      const { state, review } = await askAgent(followUpGraph("task", undefined, tools, seen), "cerrá ese ticket", "m5", history);
      expect(state.route).toBe("sensitive");
      expect(review).toBeDefined();
      expect(tools.calls).toEqual([]);
    });
  });
});
