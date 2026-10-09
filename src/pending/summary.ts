import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { PendingStore, type PendingEntry } from "./store.js";

export interface TopicSummary {
  topic: string;
  count: number;
  unknown: number;
  escalated: number;
  /** Refused security requests (secrets, system prompt, jailbreaks). */
  refused: number;
  questions: string[];
  /** Suggested doc to write when the bot had no answer for this topic. */
  suggestedDoc?: string;
}

export function summarizePending(entries: PendingEntry[]): TopicSummary[] {
  const byTopic = new Map<string, PendingEntry[]>();
  for (const entry of entries) byTopic.set(entry.topic, [...(byTopic.get(entry.topic) ?? []), entry]);

  return [...byTopic.entries()]
    .map(([topic, items]) => {
      const unknown = items.filter((e) => e.reason === "unknown" || e.reason === "unsupported_task").length;
      return {
        topic,
        count: items.length,
        unknown,
        escalated: items.filter((e) => e.reason === "escalated").length,
        refused: items.filter((e) => e.reason === "security_refusal").length,
        questions: items.map((e) => e.question),
        suggestedDoc: unknown > 0 ? `knowledge/${topic}.md — documentar respuestas sobre "${topic}"` : undefined,
      };
    })
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

export function renderWelcomeBack(entries: PendingEntry[]): string {
  if (entries.length === 0) return "# Bienvenido de vuelta\n\nNo quedaron pendientes mientras no estabas.";
  const summary = summarizePending(entries);
  const lines = [
    "# Bienvenido de vuelta",
    "",
    `Mientras no estabas quedaron ${entries.length} pendientes en ${summary.length} temas.`,
  ];
  for (const topic of summary) {
    const refused = topic.refused > 0 ? ` · Rechazos de seguridad: ${topic.refused}` : "";
    lines.push("", `## ${topic.topic} (${topic.count})`, `Sin respuesta: ${topic.unknown} · Escalados: ${topic.escalated}${refused}`);
    for (const question of topic.questions) lines.push(`- ${question}`);
    if (topic.suggestedDoc) lines.push(`> Doc sugerido: ${topic.suggestedDoc}`);
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  new PendingStore(config.pendingPath)
    .list()
    .then((entries) => console.log(renderWelcomeBack(entries)))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
