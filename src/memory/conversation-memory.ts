import type { AgentTurn } from "../graph/graph.js";
import type { ConversationTurn } from "../graph/state.js";

/**
 * Short-term memory per requester (or conversation id): the last N completed turns, so
 * follow-ups like "el primero que me pasaste" resolve against earlier tool results.
 * The interface is async so a persistent store (Redis, SQLite, a Teams conversation store)
 * can replace the in-memory one without touching callers.
 */
export interface ConversationMemory {
  /** Most recent turns, oldest first. */
  recent(conversationId: string): Promise<ConversationTurn[]>;
  append(conversationId: string, turn: ConversationTurn): Promise<void>;
}

export const DEFAULT_MEMORY_TURNS = 6;

/** Parses `MEMORY_TURNS`; default 6, `0` disables memory. */
export function resolveMemoryTurns(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MEMORY_TURNS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`MEMORY_TURNS must be a non-negative integer, got "${raw}".`);
  return value;
}

export class InMemoryConversationMemory implements ConversationMemory {
  readonly #turns = new Map<string, ConversationTurn[]>();

  constructor(readonly maxTurns = DEFAULT_MEMORY_TURNS) {}

  async recent(conversationId: string): Promise<ConversationTurn[]> {
    return [...(this.#turns.get(conversationId) ?? [])];
  }

  async append(conversationId: string, turn: ConversationTurn): Promise<void> {
    if (this.maxTurns === 0) return;
    const turns = [...(this.#turns.get(conversationId) ?? []), turn];
    this.#turns.set(conversationId, turns.slice(-this.maxTurns));
  }
}

/** Builds the memory record of a finished graph turn. */
export function toConversationTurn(question: string, turn: AgentTurn): ConversationTurn {
  return {
    question,
    route: turn.state.route,
    answer: turn.state.answer ?? "",
    toolResults: turn.state.toolCalls ?? [],
  };
}

const MAX_ANSWER_CHARS = 400;

/** Compact Spanish rendering of the history for prompts (questions, routes and trimmed answers). */
export function renderHistory(history: ConversationTurn[]): string {
  return history
    .map((turn, i) => {
      const answer = turn.answer.split("\n\nFuentes:")[0]!.replace(/\s+/g, " ").trim();
      const trimmed = answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS - 1)}…` : answer;
      return `Turno ${i + 1} (${turn.route ?? "?"})\nUsuario: ${turn.question}\nSuplente: ${trimmed}`;
    })
    .join("\n\n");
}
