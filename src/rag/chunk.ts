export interface Chunk {
  id: string;
  /** Source file, relative to the knowledge directory. */
  source: string;
  /** Heading path, e.g. "Publicar una librería > Versionado". */
  heading: string;
  text: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/** Splits a markdown document by headings, then by paragraphs when a section exceeds maxChars. */
export function chunkMarkdown(source: string, markdown: string, maxChars = 900): Chunk[] {
  const sections: { heading: string; lines: string[] }[] = [];
  const path: string[] = [];
  let current: { heading: string; lines: string[] } = { heading: "", lines: [] };
  sections.push(current);

  // HTML comments are invisible when the doc is rendered; dropping them keeps hidden text out of the index.
  for (const line of stripHtmlComments(markdown).split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (!match) {
      current.lines.push(line);
      continue;
    }
    const level = match[1]!.length;
    path.length = level - 1;
    path[level - 1] = match[2]!;
    current = { heading: path.filter(Boolean).join(" > "), lines: [] };
    sections.push(current);
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const text of splitByParagraph(section.lines.join("\n").trim(), maxChars)) {
      chunks.push({ id: `${source}#${chunks.length}`, source, heading: section.heading, text });
    }
  }
  return chunks;
}

export function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?(-->|$)/g, "");
}

function splitByParagraph(text: string, maxChars: number): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let buffer = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }
    if (buffer) parts.push(buffer);
    buffer = paragraph;
    while (buffer.length > maxChars) {
      parts.push(buffer.slice(0, maxChars));
      buffer = buffer.slice(maxChars);
    }
  }
  if (buffer) parts.push(buffer);
  return parts;
}
