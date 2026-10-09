/**
 * Presentation of answers to the requester (CLI, Teams, ...). The graph always produces
 * `[n]` markers and a "Fuentes:" block (needed by evals and logs); whether the requester sees
 * them is decided here, with `SHOW_CITATIONS` (default false).
 */

const SOURCES_BLOCK = /\n+Fuentes:\n[\s\S]*$/u;
const MARKER_WITH_SPACE = /[ \t]*\[\d+(?:\s*[,–-]\s*\d+)*\]/gu;

/** Parses `SHOW_CITATIONS` (`true`/`false`, `1`/`0`, `yes`/`no`); default false. */
export function resolveShowCitations(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return false;
  if (["true", "1", "yes", "si", "sí"].includes(value)) return true;
  if (["false", "0", "no"].includes(value)) return false;
  throw new Error(`SHOW_CITATIONS must be true or false, got "${raw}".`);
}

/** Removes `[n]` markers (outside inline code) and the trailing "Fuentes:" block, then tidies spacing. */
export function stripCitations(text: string): string {
  const body = text.replace(SOURCES_BLOCK, "");
  return body
    .split(/(`[^`\n]*`)/u)
    .map((part, i) => (i % 2 === 1 ? part : tidy(part.replace(MARKER_WITH_SPACE, ""))))
    .join("")
    .trimEnd();
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]*\(\s*\)/gu, "") // "texto ([1])" → "texto"
    .replace(/[ \t]+([.,;:!?)])/gu, "$1") // "texto [1] ." → "texto."
    .replace(/,{2,}/gu, ",") // "404 [2], [3], sigue" → "404, sigue"
    .replace(/,(?=[.;:!?])/gu, "") // "texto [1], [2]." → "texto."
    .replace(/(\S)[ \t]{2,}/gu, "$1 ") // inner double spaces (leading indentation is kept)
    .replace(/[ \t]+(?=\n)/gu, ""); // trailing spaces per line (the end of the text is trimmed by the caller)
}

export function formatAnswerForUser(answer: string, { showCitations }: { showCitations: boolean }): string {
  return showCitations ? answer : stripCitations(answer);
}
