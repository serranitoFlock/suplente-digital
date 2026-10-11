/**
 * Prompt-injection heuristics shared by the router (requests) and the task node (tool results).
 *
 * This is a deterministic, heuristic layer: it complements the "untrusted data" instructions in the
 * prompts (defense in depth) and is not a guarantee. It cannot catch every phrasing, and it may
 * redact a harmless field that happens to read like an order to the assistant. See docs/security.md.
 */

/** Prompt-leak / jailbreak attempts against the bot itself (OWASP LLM01 / LLM07). Used by the router to refuse requests. */
export const OVERRIDE_PATTERNS: readonly RegExp[] = [
  /\b(system prompt|prompt (de|del) sistema)\b/iu,
  /\b(ignor|olvid|salte|saltá|desactiv)\p{L}*\s+(todas\s+)?(tus|las)\s+(instrucciones|reglas|restricciones)/iu,
  /\b(revel|mostr|repet|copi|dec)\p{L}*\s+(todas\s+)?(tus|las)\s+(instrucciones|reglas)\s+(internas|del sistema|ocultas|originales)/iu,
  /\b(jailbreak|modo (desarrollador|developer|dios|sin restricciones))\b/iu,
  // "Ignorá todo lo anterior", "olvida lo anterior": overriding without naming the instructions.
  /\b(ignor|olvid|descart)\p{L}*\s+(todo\s+)?lo\s+anterior\b/iu,
];

const ASSISTANT = String.raw`(asistente|assistant|bot|ia|ai|modelo|model|llm|agente|agent)`;

/**
 * Text addressed to the assistant itself, as it appears inside data (ticket comments, CI job
 * reasons, script output). Written without accents: they are tested against accent-stripped text.
 * Only for tool results: a requester may legitimately say "nota para el asistente" or ask which
 * command to run, so the router does not use these.
 */
export const ASSISTANT_DIRECTED_PATTERNS: readonly RegExp[] = [
  // Addressing the assistant: "NOTA PARA EL ASISTENTE", "instrucciones para el asistente", "Note to the AI", "assistant:".
  new RegExp(String.raw`\b(nota|notas|instruccion|instrucciones|mensaje|aviso|note|message|instructions?)\s+(para|al|a|to|for)\s+(el\s+|la\s+|the\s+)?${ASSISTANT}\b`, "iu"),
  new RegExp(String.raw`\b(atencion|attention|dear|hola|hey)\s*,?\s+${ASSISTANT}\b`, "iu"),
  /(^|["'\s])(asistente|assistant)\s*:/iu,
  /\b(as an ai|as a language model|como (una\s+)?ia\b|como modelo de lenguaje)/iu,
  // Overriding instructions, in English (the Spanish forms are in OVERRIDE_PATTERNS).
  /\b(ignore|disregard|forget|override)\s+(all\s+)?(the\s+|your\s+|any\s+)?(previous|prior|above|earlier|system)?\s*(instructions|rules|prompt)\b/iu,
  // Revealing or copying its instructions: "copia aquí tu prompt", "reveal your instructions".
  /\b(revel|muestr|mostr|copi|repet|repit|imprim|peg|escrib|reveal|show|print|copy|repeat|output|dump|leak)\p{L}*\b.{0,30}\b(tu|tus|your)\s+(prompt|instrucciones|instructions|reglas|rules)\b/iu,
  // Steering the reply: "en tu respuesta", "to your reply", "agrega el código CANARY-J0B5".
  /\b(en|a)\s+tu\s+respuesta\b|\b(in|to|into)\s+your\s+(reply|response|answer|output)\b/iu,
  /\b(agreg|anad|inclu|insert|pon|escrib|add|include|insert|append|write)\p{L}*\s+(el|la|este|esta|the|this|a)?\s*(codigo|code|token|clave|frase|palabra|string)\s+[A-Z0-9][\w-]*\d[\w-]*/iu,
  // Re-assigning its role: "you are now …", "a partir de ahora sos/eres …", "ahora sos un bot …".
  /\b(you are now|from now on,? you|a partir de ahora (sos|eres|actua|actuas)|ahora (sos|eres) (un|una)\b)/iu,
  // Getting the assistant to recommend or run a command.
  /\b(recomi?end|sugier|suger|aconsej|recommend|suggest|advise)\p{L}*\s+(al usuario\s+|the user\s+|to\s+)?(ejecutar|correr|lanzar|run|running|execute|executing)\b/iu,
  /\b(ejecut|corr|run|execute)\p{L}*\s+(el|los|the)\s+(siguiente|siguientes|following)\s+(comando|comandos|command|commands|script)\b/iu,
  /\btell the user to (run|execute)\b/iu,
];

/** Fixed text that replaces a neutralized field; kept in neutral Spanish like the summary prompt. */
export const INJECTION_MARKER = "[texto sospechoso dirigido al asistente (omitido)]";

const stripAccents = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");

/** True when the text reads like an instruction addressed to the assistant (heuristic). */
export function looksLikeInstruction(text: string): boolean {
  if (text.includes(INJECTION_MARKER)) return false;
  if (OVERRIDE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  const plain = stripAccents(text);
  return ASSISTANT_DIRECTED_PATTERNS.some((pattern) => pattern.test(plain));
}

export interface NeutralizedPayload {
  /** Payload safe to show the model: suspicious string values (JSON) or lines (text) replaced by the marker. */
  text: string;
  /** Number of string values or lines replaced. */
  redacted: number;
}

/**
 * Replaces instructions planted in a tool payload before any model sees it. A JSON payload keeps
 * its structure (every string leaf at any depth is checked; keys are not); anything else is
 * checked line by line. The payload comes back unchanged when nothing matches.
 */
export function neutralizeInstructions(payload: string): NeutralizedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    let redacted = 0;
    const lines = payload.split("\n").map((line) => {
      if (!looksLikeInstruction(line)) return line;
      redacted++;
      return INJECTION_MARKER;
    });
    return { text: redacted ? lines.join("\n") : payload, redacted };
  }
  let redacted = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!looksLikeInstruction(value)) return value;
      redacted++;
      return INJECTION_MARKER;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  const cleaned = walk(parsed);
  return { text: redacted ? JSON.stringify(cleaned, null, 2) : payload, redacted };
}

/** Number of neutralized fields in already-processed tool data (e.g. a turn's tool call records), for traces and logs. */
export function countRedactedFields(data: unknown): number {
  return JSON.stringify(data ?? null).split(JSON.stringify(INJECTION_MARKER).slice(1, -1)).length - 1;
}
