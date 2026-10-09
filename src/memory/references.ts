import type { ConversationTurn, ReferencedItem, ReferenceResolution, ToolCallRecord } from "../graph/state.js";

/**
 * Deterministic resolution of follow-up references ("el primero que me pasaste", "el segundo
 * pipeline", "ese ticket") against earlier tool results. Never guesses: when the reference
 * cannot be resolved to exactly one item, the result is `ambiguous` and the bot asks.
 */

const ORDINALS: Record<string, number> = {
  primer: 0,
  primero: 0,
  primera: 0,
  segundo: 1,
  segunda: 1,
  tercer: 2,
  tercero: 2,
  tercera: 2,
  cuarto: 3,
  cuarta: 3,
  ultimo: -1,
  ultima: -1,
};

const ENTITY_NOUN = String.raw`(pipelines?|jobs?|tickets?|tareas?|fallas?|errores|error)`;
const ORDINAL_WORD = String.raw`(primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|[úu]ltim[oa])`;

/** "el primero", "la segunda", "del último" used as a pronoun (not "el primer web component"). */
const ORDINAL_PRONOUN = new RegExp(
  String.raw`(?<!\p{L})(?:el|la|al|del)\s+${ORDINAL_WORD}(?=\s*$|\s*[?¿!.,;:)]|\s+(?:que|de|del|en|y)(?!\p{L}))`,
  "iu",
);
/** "el primer pipeline", "el segundo ticket", "la última falla". */
const ORDINAL_NOUN = new RegExp(String.raw`(?<!\p{L})(?:el|la|al|del)\s+${ORDINAL_WORD}\s+${ENTITY_NOUN}(?!\p{L})`, "iu");
/** "ese ticket", "esa falla", "aquel pipeline", "el pipeline que me pasaste". */
const DEMONSTRATIVE = new RegExp(
  String.raw`(?<!\p{L})(?:es[eao]s?|aquel(?:la|los|las)?)\s+${ENTITY_NOUN}(?!\p{L})|(?<!\p{L})(?:el|la)\s+${ENTITY_NOUN}\s+que\s+me\s+(?:pasaste|mostraste|listaste|diste|mandaste|dijiste)(?!\p{L})`,
  "iu",
);
/** Explicit identifiers win over references: a ticket key or a component/pipeline name. */
const EXPLICIT_ID = /\b[A-Z][A-Z0-9]+-\d+\b|\bacme-[a-z0-9-]+/iu;

const PIPELINE_NOUN = /(?<!\p{L})(pipelines?|jobs?|fallas?|errores|error)(?!\p{L})/iu;
const TICKET_NOUN = /(?<!\p{L})(tickets?|tareas?)(?!\p{L})/iu;

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

type Detected = { ordinal: number } | { demonstrative: true };

function detect(question: string): Detected | null {
  const ordinal = ORDINAL_NOUN.exec(question) ?? ORDINAL_PRONOUN.exec(question);
  if (ordinal) return { ordinal: ORDINALS[fold(ordinal[1]!)] ?? 0 };
  if (DEMONSTRATIVE.test(question)) return { demonstrative: true };
  return null;
}

function itemKind(data: Record<string, unknown>): ReferencedItem["kind"] {
  if (typeof data.key === "string") return "ticket";
  if (typeof data.pipeline === "string") return "pipeline";
  return "item";
}

function label(item: { kind: ReferencedItem["kind"]; data: Record<string, unknown> }): string {
  const { data } = item;
  if (item.kind === "ticket") return `ticket ${String(data.key)}${data.summary ? ` (${String(data.summary)})` : ""}`;
  if (item.kind === "pipeline") return `pipeline ${String(data.pipeline)}${data.job ? ` (job ${String(data.job)})` : ""}`;
  return JSON.stringify(data).slice(0, 80);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Items of one tool result (a list, or a single object that is not an error). */
function itemsOf(record: ToolCallRecord): ReferencedItem[] {
  const raw = Array.isArray(record.result) ? record.result : isRecord(record.result) && !("error" in record.result) ? [record.result] : [];
  return raw.filter(isRecord).map((data) => {
    const kind = itemKind(data);
    return { kind, tool: record.tool, label: label({ kind, data }), data };
  });
}

/** Most recent tool result (newest turn first) whose items match the wanted kind. */
function latestItems(history: ConversationTurn[], wanted: ReferencedItem["kind"] | undefined): ReferencedItem[] | undefined {
  for (const turn of [...history].reverse()) {
    for (const record of [...turn.toolResults].reverse()) {
      const items = itemsOf(record);
      if (items.length > 0 && (!wanted || items.every((item) => item.kind === wanted))) return items;
    }
  }
  return undefined;
}

export const CLARIFY_NO_CONTEXT =
  "No encuentro en esta conversación un resultado anterior al que pueda referirse ese pedido. ¿Puedes indicarme el nombre del pipeline o la clave del ticket (por ejemplo, DEMO-101)?";

/** True when the question points back at an earlier result ("el primero", "ese ticket"). */
export function hasFollowUpReference(question: string): boolean {
  return !EXPLICIT_ID.test(question) && detect(question) !== null;
}

export function resolveReference(question: string, history: ConversationTurn[]): ReferenceResolution {
  if (EXPLICIT_ID.test(question)) return { kind: "none" };
  const detected = detect(question);
  if (!detected) return { kind: "none" };

  const wanted = PIPELINE_NOUN.test(question) ? "pipeline" : TICKET_NOUN.test(question) ? "ticket" : undefined;
  const items = latestItems(history, wanted);
  if (!items) return { kind: "ambiguous", message: CLARIFY_NO_CONTEXT };

  const options = items.map((item, i) => `${i + 1}) ${item.label}`).join("; ");
  if ("ordinal" in detected) {
    const index = detected.ordinal < 0 ? items.length - 1 : detected.ordinal;
    const item = items[index];
    if (item) return { kind: "resolved", item };
    return {
      kind: "ambiguous",
      message: `El último resultado que te pasé tiene ${items.length} ${items.length === 1 ? "elemento" : "elementos"}: ${options}. ¿Cuál de ellos necesitas?`,
    };
  }
  if (items.length === 1) return { kind: "resolved", item: items[0]! };
  return { kind: "ambiguous", message: `No sé con certeza a cuál te refieres. El último resultado tenía: ${options}. ¿Cuál de ellos necesitas?` };
}
