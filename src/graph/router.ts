import { z } from "zod";
import { extractJson, type Llm } from "../llm.js";
import { ROUTES, type Route, type State, type Update } from "./state.js";

export interface RouterDecision {
  route: Route;
  topic: string;
  reason: string;
}

const decisionSchema = z.object({
  route: z.enum(ROUTES),
  topic: z.string().optional(),
  reason: z.string().default(""),
});

/**
 * Deterministic safety net: requests that are irreversible or involve secrets
 * always go to human review, regardless of what the model says.
 */
const WORD_END = String.raw`(?!\p{L})`;
const SENSITIVE_PATTERNS = [
  new RegExp(String.raw`\b(borr(ar|á|a|alo|ala|en)|elimin(ar|á|a|alo|en)|delete|drop)${WORD_END}`, "iu"),
  /\b(deploy|despleg|desplieg)\p{L}*.*\bproducci[oó]n/iu,
  /\bproducci[oó]n\b.*\b(deploy|despleg|desplieg|sub[ií]|pas[aá])/iu,
  /\b(merge[aá](lo|me)?|mergear|hac[eé] (el )?merge)(?!\p{L})/iu,
  /\b(revoc|otorg|aprob)(á|ar|a|ame|alo|ale)(?!\p{L}).*\b(acceso|permiso|mr|merge|release)/iu,
  /\b(token|contraseñ|password|credencial|secret)\p{L}*/iu,
  /\bforce[- ]?push/iu,
];

export function detectSensitive(question: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(question));
}

export function parseRouterOutput(text: string): RouterDecision {
  const parsed = decisionSchema.safeParse(extractJson(text));
  if (!parsed.success) return { route: "question", topic: "general", reason: "fallback: salida del router inválida" };
  return { route: parsed.data.route, topic: slugify(parsed.data.topic), reason: parsed.data.reason };
}

function slugify(topic: string | undefined): string {
  const slug = (topic ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "general";
}

export const ROUTER_PROMPT = `Sos el router de un "suplente digital" que cubre a un arquitecto frontend (web components con Angular Elements, librerías Angular compartidas, shell app, manifiesto de versiones en CDN, pipelines de CI) mientras está de vacaciones.
Clasificá el pedido del usuario en una ruta:
- "question": pregunta de conocimiento/procedimiento que se responde con documentación.
- "task": pedido de información operativa en vivo (estado de un ticket, buscar tickets, pipelines/jobs fallidos).
- "sensitive": cualquier acción irreversible o con permisos (borrar, mergear, desplegar a producción, aprobar, cambiar accesos, pedir secretos/tokens) o decisiones que solo puede tomar la persona.
- "out_of_scope": nada que ver con el trabajo del equipo.
Respondé SOLO con JSON: {"route": "...", "topic": "<tema corto en 1-2 palabras>", "reason": "<motivo breve>"}`;

export function makeRouterNode(llm: Llm) {
  return async (state: State): Promise<Update> => {
    const decision = parseRouterOutput(await llm(ROUTER_PROMPT, state.question));
    if (detectSensitive(state.question) && decision.route !== "sensitive") {
      return { route: "sensitive", topic: decision.topic, routeReason: "regla de seguridad: pedido irreversible o sensible" };
    }
    return { route: decision.route, topic: decision.topic, routeReason: decision.reason };
  };
}
