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
 *
 * Action patterns (delete, deploy to production, merge, permissions, force push)
 * are skipped when the message is framed as a how-to question ("¿Cómo despliego…?")
 * and contains no imperative: explaining a procedure from the docs is safe, doing it is not.
 * Secret patterns never get that exemption.
 */
const WORD_END = String.raw`(?!\p{L})`;
const ACTION_PATTERNS = [
  new RegExp(String.raw`\b(borr(ar|á|a|alo|ala|en)|elimin(ar|á|a|alo|en)|delete|drop)${WORD_END}`, "iu"),
  /\b(deploy|despleg|desplieg)\p{L}*.*\bproducci[oó]n/iu,
  /\bproducci[oó]n\b.*\b(deploy|despleg|desplieg|sub[ií]|pas[aá])/iu,
  /\b(merge[aá](lo|me)?|mergear|hac[eé] (el )?merge)(?!\p{L})/iu,
  /\b(revoc|otorg|aprob)(á|ar|a|ame|alo|ale)(?!\p{L}).*\b(acceso|permiso|mr|merge|release)/iu,
  /\bforce[- ]?push/iu,
  // Ticket mutations: the catalog has no write tools, so a request to change a ticket goes to a human.
  /(?<!\p{L})(cerr(á|ar|alo|ala)|reasign\p{L}*|asign(á|ar|ame|amelo|alo|ala)|transicion(á|ar|alo))(?!\p{L}).*\b(ticket|[A-Z][A-Z0-9]+-\d+)/iu,
];
const SECRET_PATTERNS = [
  /\b(token|contraseñ|password|credencial|secret)\p{L}*/iu,
  // Prompt-leak / jailbreak attempts against the bot itself (OWASP LLM01 / LLM07).
  /\b(system prompt|prompt (de|del) sistema)\b/iu,
  /\b(ignor|olvid)\p{L}*\s+(todas\s+)?(tus|las)\s+instrucciones/iu,
];

/** "¿Cómo…?", "¿Cuáles son los pasos para…?", "¿Qué tengo que hacer para…?" and similar procedure questions. */
const HOW_TO_FRAMING =
  /^\s*¿?\s*(c[oó]mo|cu[aá]l(es)? (son|es) (los pasos|el procedimiento|el proceso)|qu[eé] pasos|qu[eé] (tengo|hay) que hacer|qu[eé] reviso)(?!\p{L})/iu;

/** Voseo / clitic imperatives that turn a message into an order ("borrala", "mergealo", "desplegá", "pasame"). */
const IMPERATIVE =
  /(?<!\p{L})(borr[aá]|elimin[aá]|merge[aá]|despleg[aá]|revoc[aá]|otorg[aá]|aprob[aá]|hac[eé]|pas[aá]|d[aá]|mostr[aá])(me|lo|la|los|las|le)(?!\p{L})|(?<!\p{L})(borrá|eliminá|mergeá|desplegá|revocá|otorgá|aprobá|hacé|pasá|mostrá)(?!\p{L})/iu;

export function isHowToQuestion(question: string): boolean {
  return HOW_TO_FRAMING.test(question) && !IMPERATIVE.test(question);
}

export function detectSensitive(question: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(question))) return true;
  if (isHowToQuestion(question)) return false;
  return ACTION_PATTERNS.some((pattern) => pattern.test(question));
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
Clasificá el mensaje en UNA ruta:
- "question": la persona pregunta CÓMO se hace algo, QUÉ revisar ante un problema, A QUIÉN recurrir, o cuál es una regla/convención del equipo. Se responde con la documentación. Incluye preguntas sobre despliegues, CDN, versiones o incidentes mientras pidan una explicación o una guía, no que el bot actúe.
- "task": la persona pide que el bot CONSULTE AHORA un sistema en vivo y le traiga un dato concreto: estado de un ticket puntual, buscar tickets, listar pipelines o jobs fallidos.
- "sensitive": la persona pide que el bot EJECUTE una acción irreversible o con permisos (borrar, mergear, desplegar a producción, aprobar, dar o quitar accesos) o que revele secretos (tokens, contraseñas, credenciales). También decisiones que solo puede tomar la persona responsable.
- "out_of_scope": nada que ver con el trabajo del equipo.
Regla de decisión: preguntate "¿me pide que HAGA algo o que consulte un sistema ahora, o me pregunta CÓMO / A QUIÉN / QUÉ revisar?".
- Si pregunta cómo, a quién o qué revisar → "question" (aunque mencione producción, CDN o un incidente).
- Si pide un dato vivo de tickets o pipelines → "task".
- Si pide ejecutar algo irreversible o un secreto → "sensitive".
Ejemplos:
Mensaje: "¿Cómo agrego un input nuevo a acme-footer sin romper a los consumidores?" → {"route": "question", "topic": "web-components", "reason": "pregunta cómo hacerlo"}
Mensaje: "La librería @acme/forms tira un error de peer dependency al instalarla, ¿por dónde empiezo?" → {"route": "question", "topic": "librerias", "reason": "pide qué revisar"}
Mensaje: "¿Con quién hablo si se cae el registry de npm un fin de semana?" → {"route": "question", "topic": "soporte", "reason": "pregunta a quién recurrir"}
Mensaje: "¿Cuál es el proceso para pasar acme-footer a producción?" → {"route": "question", "topic": "despliegue", "reason": "pide el procedimiento, no que lo ejecute"}
Mensaje: "Fijate en qué quedó el ticket SHOP-77" → {"route": "task", "topic": "tickets", "reason": "consulta en vivo de un ticket"}
Mensaje: "Listame los jobs rotos de los últimos 3 días" → {"route": "task", "topic": "pipelines", "reason": "consulta en vivo de pipelines"}
Mensaje: "Subí acme-footer 3.1 a producción ahora" → {"route": "sensitive", "topic": "despliegue", "reason": "pide ejecutar un despliegue a producción"}
Mensaje: "Dame acceso de maintainer al repo de la shell" → {"route": "sensitive", "topic": "accesos", "reason": "pide cambiar permisos"}
Mensaje: "¿Qué me recomendás para cenar hoy?" → {"route": "out_of_scope", "topic": "general", "reason": "no es del equipo"}
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
