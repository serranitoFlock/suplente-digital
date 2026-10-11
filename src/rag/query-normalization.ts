/**
 * Masks identifiers the corpus never mentions before a query is embedded (retrieval only; the
 * router, the answer prompt and memory keep the original question, as with the glossary).
 *
 * A specific name the docs do not contain ("el componente acme-header no carga") carries no
 * information about which doc answers, but its shape still pulls the small embedding model toward
 * docs that list sibling names (acme-card, cdn.example.com), away from the doc about the actual
 * problem. Dropping it leaves the words that describe the problem ("el componente no carga").
 */

/**
 * Identifier-like token: letter/digit segments joined by `-`, `/`, `.`, `_` or `:` (optionally
 * scoped with a leading `@`), with at least one letter: `acme-card`, `@acme/ui-kit`, `app.config.ts`,
 * `deploy:cdn-qa`, `DEMO-101`. Plain words, numbers, versions (`4.2.1`) and times never match.
 */
const IDENTIFIER = /(?<![\p{L}\p{N}@/._:-])@?[\p{L}\p{N}]+(?:[-/._:][\p{L}\p{N}]+)+/gu;
const HAS_LETTER = /\p{L}/u;

export function identifierTokens(text: string): string[] {
  return (text.match(IDENTIFIER) ?? []).filter((token) => HAS_LETTER.test(token));
}

/** Every identifier-like token of the corpus, once, lowercased and sorted (stored in the index). */
export function buildIdentifierVocabulary(texts: Iterable<string>): string[] {
  const vocabulary = new Set<string>();
  for (const text of texts) for (const token of identifierTokens(text)) vocabulary.add(token.toLowerCase());
  return [...vocabulary].sort();
}

/**
 * Naming family of an identifier: its leading segment before the first `-`, `/` or `:` (`acme` for
 * `acme-card` and `@acme/ui-kit`, `demo` for `DEMO-101`); none for dotted-only names such as file
 * names or hosts, and none for one-letter prefixes.
 */
function family(identifier: string): string | undefined {
  const match = /^@?([\p{L}\p{N}._]+)[-/:]/u.exec(identifier.toLowerCase());
  return match && match[1]!.length >= 2 ? match[1] : undefined;
}

interface Mask {
  known: Set<string>;
  families: Set<string>;
}

const masks = new WeakMap<readonly string[], Mask>();

function maskFor(vocabulary: readonly string[]): Mask {
  let mask = masks.get(vocabulary);
  if (!mask) {
    const counts = new Map<string, number>();
    for (const identifier of vocabulary) {
      const name = family(identifier);
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    // A family is a naming convention the corpus uses for several things, not one hyphenated word.
    mask = { known: new Set(vocabulary.map((v) => v.toLowerCase())), families: new Set([...counts].filter(([, n]) => n >= 2).map(([name]) => name)) };
    masks.set(vocabulary, mask);
  }
  return mask;
}

/**
 * Drops identifier-like tokens that are absent from the corpus `vocabulary` but belong to a naming
 * family it uses (at least two corpus identifiers share their leading segment): an unknown
 * `acme-header` or `DEMO-999` is an instance of a known kind whose specific name is undocumented.
 * Unknown names outside those families (`server-side`, `chart.js`) are kept: they may be exactly
 * what makes a question out of scope, and masking them would raise its retrieval scores. The token is
 * removed rather than replaced with a generic noun: the surrounding words usually already say what it
 * is, and removal does not depend on the corpus language. No vocabulary (an index built before it
 * existed) means no masking, and a query that would be left without letters is returned unchanged.
 */
export function maskUnknownIdentifiers(query: string, vocabulary: readonly string[]): string {
  if (vocabulary.length === 0) return query;
  const { known, families } = maskFor(vocabulary);
  const masked = query.replace(new RegExp(`(\\s*)(${IDENTIFIER.source})(\\s*)`, "gu"), (match, before: string, token: string, after: string) => {
    const name = family(token);
    if (!HAS_LETTER.test(token) || known.has(token.toLowerCase()) || !name || !families.has(name)) return match;
    // One space only between two words ("componente acme-header no" → "componente no"; "publico @acme/x?" → "publico?").
    return before && after ? " " : "";
  });
  return HAS_LETTER.test(masked) ? masked.trim() : query;
}
