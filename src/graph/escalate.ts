import { interrupt } from "@langchain/langgraph";
import type { GraphDeps, ReviewDecision, ReviewRequest, State, Update } from "./state.js";

export const DRAFT_PROMPT = `Sos el suplente digital de un arquitecto frontend. El pedido es sensible o irreversible y NO lo vas a ejecutar.
Redactá en español neutro un borrador breve para que el backup humano lo revise: qué se pidió, riesgos, pasos sugeridos y una respuesta propuesta para quien lo pidió.
Nunca incluyas secretos, tokens ni credenciales.`;

export function makeDraftNode({ llm }: Pick<GraphDeps, "llm">) {
  return async (state: State): Promise<Update> => ({ draft: (await llm(DRAFT_PROMPT, state.question)).trim() });
}

/**
 * Pauses the graph until the human backup decides. Side effects live after
 * `interrupt()` because LangGraph re-runs the node from the top on resume.
 */
export function makeHumanReviewNode({ pending }: Pick<GraphDeps, "pending">) {
  return async (state: State): Promise<Update> => {
    const decision = interrupt<ReviewRequest, ReviewDecision>({ question: state.question, draft: state.draft });
    await pending.append({
      question: state.question,
      topic: state.topic,
      reason: "escalated",
      draft: state.draft,
      decision: decision.approved ? "approved" : "rejected",
      note: decision.note,
    });
    if (decision.approved) {
      return {
        outcome: "approved",
        answer: `El backup humano aprobó esta respuesta (la acción en sí la ejecuta una persona, no el bot):\n\n${state.draft}`,
      };
    }
    return {
      outcome: "rejected",
      answer: `Este pedido requiere a la persona responsable; quedó registrado para su vuelta.${decision.note ? `\nNota del backup: ${decision.note}` : ""}`,
    };
  };
}

export function outOfScopeNode(): Update {
  return {
    outcome: "out_of_scope",
    answer: "Solo puedo ayudar con temas de arquitectura frontend del equipo (web components, librerías, CDN, pipelines y tickets).",
  };
}
