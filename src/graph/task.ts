import { parseToolCall, toolDescriptions } from "../tools/types.js";
import type { GraphDeps, State, Update } from "./state.js";

const today = () => new Date().toISOString().slice(0, 10);

export const TOOL_SELECTION_PROMPT = `Elegí UNA herramienta de solo lectura para resolver el pedido. Herramientas:
${Object.entries(toolDescriptions)
  .map(([name, description]) => `- ${name}: ${description}`)
  .join("\n")}
Si ninguna sirve, usá {"tool": "none"}.
Respondé SOLO con JSON: {"tool": "<nombre>", "args": {...}}`;

export const TOOL_SUMMARY_PROMPT = `Sos el suplente digital de un arquitecto frontend. Resumí en español neutro y en pocas líneas el resultado de la herramienta para responder el pedido.
Usá solo los datos del resultado; si está vacío o es un error, decilo claramente. No ofrezcas ejecutar acciones: solo tenés acceso de lectura.`;

export function makeTaskNode({ llm, tools, pending }: Pick<GraphDeps, "llm" | "tools" | "pending">) {
  return async (state: State): Promise<Update> => {
    const call = parseToolCall(await llm(TOOL_SELECTION_PROMPT, `Fecha de hoy: ${today()}\nPedido: ${state.question}`));
    if (!call) {
      await pending.append({ question: state.question, topic: state.topic, reason: "unsupported_task" });
      return {
        outcome: "unknown",
        answer: "No tengo una herramienta para resolver ese pedido. Lo dejé registrado para la persona responsable.",
      };
    }

    const result = await tools.call(call);
    const summary = await llm(TOOL_SUMMARY_PROMPT, `Pedido: ${state.question}\nHerramienta: ${call.tool} ${JSON.stringify(call.args)}\nResultado:\n${result}`);
    return {
      outcome: "answered",
      sources: [],
      answer: `${summary.trim()}\n\n(Consulta de solo lectura: ${call.tool} vía ${tools.name})`,
    };
  };
}
