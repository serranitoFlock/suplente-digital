import type { DatabaseSync } from "node:sqlite";
import type { ConversationTurn } from "../graph/state.js";
import { DEFAULT_MEMORY_TURNS, type ConversationMemory } from "../memory/conversation-memory.js";
import { applyMigrations, transaction, type SchemaModule } from "./sqlite.js";

export const MEMORY_SCHEMA: SchemaModule = {
  name: "conversation_memory",
  migrations: [
    `CREATE TABLE conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      turn TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX conversation_turns_by_conversation ON conversation_turns (conversation_id, id);`,
  ],
};

/**
 * Short-term memory in the shared SQLite database, with the same semantics as `InMemoryConversationMemory`:
 * the last `maxTurns` turns per conversation, oldest first; `0` stores nothing. Turns are stored as JSON.
 */
export class SqliteConversationMemory implements ConversationMemory {
  constructor(
    readonly db: DatabaseSync,
    /** Mutable so the admin panel can change it at runtime; applies from the next read/append. */
    public maxTurns = DEFAULT_MEMORY_TURNS,
  ) {
    applyMigrations(db, MEMORY_SCHEMA);
  }

  async recent(conversationId: string): Promise<ConversationTurn[]> {
    if (this.maxTurns === 0) return [];
    const rows = this.db
      .prepare("SELECT turn FROM (SELECT id, turn FROM conversation_turns WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(conversationId, this.maxTurns) as unknown as { turn: string }[];
    return rows.map((row) => JSON.parse(row.turn) as ConversationTurn);
  }

  async append(conversationId: string, turn: ConversationTurn): Promise<void> {
    if (this.maxTurns === 0) return;
    transaction(this.db, () => {
      this.db
        .prepare("INSERT INTO conversation_turns (conversation_id, turn, created_at) VALUES (?, ?, ?)")
        .run(conversationId, JSON.stringify(turn), new Date().toISOString());
      // Trim, so the table does not grow without bound.
      this.db
        .prepare(
          `DELETE FROM conversation_turns WHERE conversation_id = ? AND id NOT IN (
            SELECT id FROM conversation_turns WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
          )`,
        )
        .run(conversationId, conversationId, this.maxTurns);
    });
  }
}
