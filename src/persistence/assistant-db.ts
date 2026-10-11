import type { DatabaseSync } from "node:sqlite";
import { JOB_SCHEMA, SqliteJobStore } from "./job-store.js";
import { CHECKPOINT_SCHEMA, SqliteCheckpointSaver } from "./sqlite-checkpointer.js";
import { SETTINGS_SCHEMA } from "./settings-store.js";
import { MEMORY_SCHEMA, SqliteConversationMemory } from "./sqlite-memory.js";
import { openDatabase, type SchemaModule } from "./sqlite.js";

/** Every schema module the assistant keeps in its database (checkpoints, jobs, conversation memory, runtime settings). */
export const ASSISTANT_SCHEMAS: readonly SchemaModule[] = [CHECKPOINT_SCHEMA, JOB_SCHEMA, MEMORY_SCHEMA, SETTINGS_SCHEMA];

/** The assistant's persistent state, all on one SQLite connection owned by the caller. */
export interface AssistantStores {
  db: DatabaseSync;
  checkpointer: SqliteCheckpointSaver;
  jobs: SqliteJobStore;
  memory: SqliteConversationMemory;
  /** Closes the database; call it after the service is idle. Idempotent. */
  close(): void;
}

/**
 * Opens (or creates) the assistant database at `path` with all its schemas and builds the stores on it.
 * One process should own a database: the job queue and the recovery assume a single writer.
 */
export function openAssistantStores(path: string, { memoryTurns }: { memoryTurns?: number } = {}): AssistantStores {
  const db = openDatabase(path, ASSISTANT_SCHEMAS);
  return {
    db,
    checkpointer: new SqliteCheckpointSaver(db),
    jobs: new SqliteJobStore(db),
    memory: new SqliteConversationMemory(db, memoryTurns),
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}
