import type { Llm } from "../llm.js";
import type { ScoredChunk } from "../rag/retriever.js";
import { NO_ANSWER, type GraphDeps, type Source, type State, type Update } from "./state.js";

const NO_ANSWER_TOKEN = "NO_SE";

export const ANSWER_PROMPT = `Sos el suplente digital de un arquitecto frontend que está de licencia. Respondés en español neutro, breve y concreto.
Reglas:
- Usá EXCLUSIVAMENTE el contexto provisto. No inventes comandos, URLs, nombres ni versiones.
- Citá las fuentes con su número entre corchetes, por ejemplo [1].
- Si el contexto no alcanza para responder con seguridad, respondé exactamente: ${NO_ANSWER_TOKEN}`;

export function formatContext(chunks: ScoredChunk[]): string {
  return chunks.map((c, i) => `[${i + 1}] ${c.source} — ${c.heading}\n${c.text}`).join("\n\n");
}

export function formatSources(sources: Source[]): string {
  return sources.map((s, i) => `[${i + 1}] ${s.source} › ${s.heading}`).join("\n");
}

export function makeAnswerNode({ llm, retriever, pending }: Pick<GraphDeps, "llm" | "retriever" | "pending">) {
  const unknown = async (state: State): Promise<Update> => {
    await pending.append({ question: state.question, topic: state.topic, reason: "unknown" });
    return {
      outcome: "unknown",
      sources: [],
      answer: `${NO_ANSWER} Dejé la pregunta registrada para cuando vuelva la persona responsable.`,
    };
  };

  return async (state: State): Promise<Update> => {
    const chunks = await retriever.retrieve(state.question);
    if (chunks.length === 0) return unknown(state);

    const reply = (await answerFromContext(llm, state.question, chunks)).trim();
    if (!reply || reply.includes(NO_ANSWER_TOKEN)) return unknown(state);

    const sources = chunks.map(({ source, heading, score }) => ({ source, heading, score }));
    return { outcome: "answered", sources, answer: `${reply}\n\nFuentes:\n${formatSources(sources)}` };
  };
}

function answerFromContext(llm: Llm, question: string, chunks: ScoredChunk[]): Promise<string> {
  return llm(ANSWER_PROMPT, `Contexto:\n${formatContext(chunks)}\n\nPregunta: ${question}`);
}
