/**
 * Team glossary (`knowledge/glosario.md`) used to normalize informal questions before embedding:
 * "no me andan los wc" is searched as "no me andan los web component". The small embedding model
 * does not know team abbreviations, and indexing the glossary as a document made it compete for the
 * doc slots with the doc that held the answer, so it is applied to the query instead.
 *
 * Format: a markdown table `| Se dice | En la documentación | Qué es |`. Aliases are comma-separated;
 * a "—" (or empty) documentation term marks a definition-only row (no rewrite).
 */
export const GLOSSARY_FILE = "glosario.md";

export interface QueryRewrite {
  aliases: string[];
  /** The term the curated docs use. */
  canonical: string;
}

const cell = (text: string) => text.replace(/[`*_]/g, "").trim();

export function parseGlossary(markdown: string): QueryRewrite[] {
  const rewrites: QueryRewrite[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(cell);
    const [said, canonical] = cells;
    if (!said || !canonical || canonical === "—" || canonical === "-" || /^:?-{3,}:?$/.test(said) || said === "Se dice") continue;
    const aliases = said.split(",").map((alias) => alias.trim()).filter((alias) => alias && alias.toLowerCase() !== canonical.toLowerCase());
    if (aliases.length > 0) rewrites.push({ aliases, canonical });
  }
  return rewrites;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces whole-word aliases (case-insensitive) with the documentation term; text already written in full is kept. */
export function normalizeQuery(query: string, rewrites: QueryRewrite[]): string {
  const pairs = rewrites
    .flatMap(({ aliases, canonical }) => aliases.map((alias) => ({ alias, canonical })))
    .sort((a, b) => b.alias.length - a.alias.length);
  if (pairs.length === 0) return query;
  const lookup = new Map(pairs.map(({ alias, canonical }) => [alias.toLowerCase(), canonical]));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${pairs.map(({ alias }) => escape(alias)).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return query.replace(pattern, (match, _alias: string, offset: number) => {
    const canonical = lookup.get(match.toLowerCase())!;
    return query.slice(offset, offset + canonical.length).toLowerCase() === canonical.toLowerCase() ? match : canonical;
  });
}
