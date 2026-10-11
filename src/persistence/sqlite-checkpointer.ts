import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import { applyMigrations, transaction, type SchemaModule } from "./sqlite.js";

/**
 * Checkpoint tables. `rowid` (implicit) keeps insertion order, which MemorySaver exposes for pending writes and
 * for the thread/namespace order of an unscoped `list`; upserts use `ON CONFLICT DO UPDATE` to keep it stable.
 */
export const CHECKPOINT_SCHEMA: SchemaModule = {
  name: "checkpoints",
  migrations: [
    `CREATE TABLE checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      type TEXT NOT NULL,
      checkpoint BLOB NOT NULL,
      metadata_type TEXT NOT NULL,
      metadata BLOB NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    );
    CREATE TABLE checkpoint_writes (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      channel TEXT NOT NULL,
      type TEXT NOT NULL,
      value BLOB NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    );`,
  ],
};

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string;
  checkpoint: Uint8Array;
  metadata_type: string;
  metadata: Uint8Array;
}

interface WriteRow {
  task_id: string;
  channel: string;
  type: string;
  value: Uint8Array;
}

const COLUMNS = "thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata_type, metadata";

function requireString(field: string, value: unknown, action: string): string {
  if (typeof value === "string" && value !== "") return value;
  throw new Error(`Failed to ${action}. The passed RunnableConfig is missing a required "${field}" field in its "configurable" property.`);
}

/**
 * LangGraph checkpointer persisted in SQLite (`node:sqlite`), so a graph paused at `interrupt()` can be resumed by
 * another process. Mirrors `MemorySaver` semantics; values go through `this.serde` and keep their serde type.
 * The caller owns the database handle (open it with `openDatabase`, close it on shutdown).
 */
export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    readonly db: DatabaseSync,
    serde?: SerializerProtocol,
  ) {
    super(serde);
    applyMigrations(db, CHECKPOINT_SCHEMA);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId !== "string") return undefined;
    const checkpointNs: string = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = getCheckpointId(config);
    const row = (
      checkpointId
        ? this.db
            .prepare(`SELECT ${COLUMNS} FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`)
            .get(threadId, checkpointNs, checkpointId)
        : this.db
            .prepare(`SELECT ${COLUMNS} FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1`)
            .get(threadId, checkpointNs)
    ) as CheckpointRow | undefined;
    if (!row) return undefined;
    // Like MemorySaver: echo the caller's config when it named a checkpoint, otherwise build one.
    return this.#toTuple(row, await this.#loadMetadata(row), checkpointId ? config : undefined);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { before, filter } = options ?? {};
    let limit = options?.limit;
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const add = (clause: string, value: SQLInputValue) => {
      where.push(clause);
      params.push(value);
    };
    if (config.configurable?.thread_id) add("c.thread_id = ?", config.configurable.thread_id);
    if (config.configurable?.checkpoint_ns !== undefined) add("c.checkpoint_ns = ?", config.configurable.checkpoint_ns);
    if (config.configurable?.checkpoint_id) add("c.checkpoint_id = ?", config.configurable.checkpoint_id);
    if (before?.configurable?.checkpoint_id) add("c.checkpoint_id < ?", before.configurable.checkpoint_id);
    // Threads, then namespaces, in first-insertion order (as MemorySaver's object keys); newest checkpoint first.
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS.split(", ").map((column) => `c.${column}`).join(", ")} FROM checkpoints c
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY (SELECT MIN(rowid) FROM checkpoints t WHERE t.thread_id = c.thread_id),
                  (SELECT MIN(rowid) FROM checkpoints n WHERE n.thread_id = c.thread_id AND n.checkpoint_ns = c.checkpoint_ns),
                  c.checkpoint_id DESC`,
      )
      .all(...params) as unknown as CheckpointRow[];
    for (const row of rows) {
      const metadata = await this.#loadMetadata(row);
      const record = metadata as Record<string, unknown>;
      if (filter && !Object.entries(filter).every(([key, value]) => record[key] === value)) continue;
      if (limit !== undefined) {
        if (limit <= 0) break;
        limit -= 1;
      }
      yield await this.#toTuple(row, metadata);
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    const threadId = requireString("thread_id", config.configurable?.thread_id, "put checkpoint");
    const checkpointNs: string = config.configurable?.checkpoint_ns ?? "";
    const [[type, serialized], [metadataType, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    this.db
      .prepare(
        `INSERT INTO checkpoints (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
           parent_checkpoint_id = excluded.parent_checkpoint_id, type = excluded.type, checkpoint = excluded.checkpoint,
           metadata_type = excluded.metadata_type, metadata = excluded.metadata`,
      )
      .run(threadId, checkpointNs, checkpoint.id, config.configurable?.checkpoint_id ?? null, type, serialized, metadataType, serializedMetadata);
    return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = requireString("thread_id", config.configurable?.thread_id, "put writes");
    const checkpointId = requireString("checkpoint_id", config.configurable?.checkpoint_id, "put writes");
    const checkpointNs: string = config.configurable?.checkpoint_ns ?? "";
    const serialized = await Promise.all(writes.map(([, value]) => this.serde.dumpsTyped(value)));
    // Regular writes keep their position in the batch and are written once (first write wins); special channels
    // (error, scheduled, interrupt, resume) use fixed negative indexes and replace the previous value.
    const insert = this.db.prepare(
      `INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    const upsert = this.db.prepare(
      `INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO UPDATE SET
         channel = excluded.channel, type = excluded.type, value = excluded.value`,
    );
    transaction(this.db, () => {
      writes.forEach(([channel], i) => {
        const idx = WRITES_IDX_MAP[channel] || i;
        const [type, value] = serialized[i]!;
        (idx >= 0 ? insert : upsert).run(threadId, checkpointNs, checkpointId, taskId, idx, channel, type, value);
      });
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM checkpoint_writes WHERE thread_id = ?").run(threadId);
      this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
    });
  }

  async #loadMetadata(row: CheckpointRow): Promise<CheckpointMetadata> {
    return this.serde.loadsTyped(row.metadata_type, row.metadata);
  }

  async #toTuple(row: CheckpointRow, metadata: CheckpointMetadata, config?: RunnableConfig): Promise<CheckpointTuple> {
    const writeRows = this.db
      .prepare("SELECT task_id, channel, type, value FROM checkpoint_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY rowid")
      .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as unknown as WriteRow[];
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      writeRows.map(async (write): Promise<CheckpointPendingWrite> => [write.task_id, write.channel, await this.serde.loadsTyped(write.type, write.value)]),
    );
    const tuple: CheckpointTuple = {
      config: config ?? { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } },
      checkpoint: await this.serde.loadsTyped(row.type, row.checkpoint),
      metadata,
      pendingWrites,
    };
    if (row.parent_checkpoint_id !== null) {
      tuple.parentConfig = { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.parent_checkpoint_id } };
    }
    return tuple;
  }
}
