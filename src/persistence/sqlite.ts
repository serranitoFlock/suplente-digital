import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A module's own schema: an ordered, append-only list of SQL migrations. Migration N (1-based) runs once per
 * database; never edit or reorder a shipped entry, append a new one instead.
 */
export interface SchemaModule {
  /** Unique name, e.g. "checkpoints" or "jobs". */
  name: string;
  migrations: readonly string[];
}

/**
 * Opens (or creates) the SQLite database at `path` and applies the given schema modules.
 * `:memory:` gives a throwaway database. The caller owns the handle and closes it.
 */
export function openDatabase(path: string, modules: readonly SchemaModule[] = []): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  for (const module of modules) applyMigrations(db, module);
  return db;
}

/** Applies the module's pending migrations, each in its own transaction; idempotent. */
export function applyMigrations(db: DatabaseSync, module: SchemaModule): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    module TEXT NOT NULL,
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (module, version)
  )`);
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?").get(module.name) as
    | { version: number | null }
    | undefined;
  const current = row?.version ?? 0;
  const record = db.prepare("INSERT INTO schema_migrations (module, version, applied_at) VALUES (?, ?, ?)");
  module.migrations.forEach((sql, i) => {
    const version = i + 1;
    if (version <= current) return;
    transaction(db, () => {
      db.exec(sql);
      record.run(module.name, version, new Date().toISOString());
    });
  });
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`, rolling back on error. `fn` must be synchronous so no other
 * caller on this connection can interleave statements inside the transaction.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
