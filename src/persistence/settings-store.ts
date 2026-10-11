import type { DatabaseSync } from "node:sqlite";
import { applyMigrations, transaction, type SchemaModule } from "./sqlite.js";

/**
 * Runtime settings set from the admin panel (key → JSON value), plus an append-only audit of every change.
 * Values here override `.env` and the config files (see `runtime-config.ts`). Secret keys are stored in clear in
 * this table (the database file must be protected like `.env`), but the audit only records whether they were set.
 */
export const SETTINGS_SCHEMA: SchemaModule = {
  name: "settings",
  migrations: [
    `CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE settings_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_at TEXT NOT NULL,
      actor TEXT NOT NULL
    );`,
  ],
};

/** Placeholder written to the audit instead of a secret value. */
export const SECRET_MASK = "***";

export interface StoredSetting {
  value: unknown;
  updatedAt: string;
}

export interface SettingsAuditEntry {
  id: number;
  key: string;
  /** Previous value (`null`: not set); secrets are `"***"`. */
  oldValue: unknown;
  /** New value (`null`: reset to the env/default); secrets are `"***"`. */
  newValue: unknown;
  changedAt: string;
  actor: string;
}

export interface SettingsStoreOptions {
  /** Keys whose values never reach the audit. */
  secretKeys?: readonly string[];
}

export class SettingsStore {
  readonly #secretKeys: ReadonlySet<string>;

  constructor(
    readonly db: DatabaseSync,
    { secretKeys = [] }: SettingsStoreOptions = {},
  ) {
    applyMigrations(db, SETTINGS_SCHEMA);
    this.#secretKeys = new Set(secretKeys);
  }

  /** Every stored setting, secrets included: for the runtime configuration only, never for an API response. */
  entries(): Map<string, StoredSetting> {
    const rows = this.db.prepare("SELECT key, value, updated_at FROM settings").all() as unknown as { key: string; value: string; updated_at: string }[];
    return new Map(rows.map((row) => [row.key, { value: JSON.parse(row.value) as unknown, updatedAt: row.updated_at }]));
  }

  /**
   * Sets (or, with `null`, deletes) several keys in one transaction and audits each key whose stored value changed.
   * Returns the changed keys.
   */
  write(changes: Record<string, unknown>, actor = "admin"): string[] {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const changed: string[] = [];
      for (const [key, value] of Object.entries(changes)) {
        const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
        const next = value === null || value === undefined ? null : JSON.stringify(value);
        const previous = row?.value ?? null;
        if (previous === next) continue;
        if (next === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
        else this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, next, now);
        this.db
          .prepare("INSERT INTO settings_audit (key, old_value, new_value, changed_at, actor) VALUES (?, ?, ?, ?, ?)")
          .run(key, this.#forAudit(key, previous), this.#forAudit(key, next), now, actor);
        changed.push(key);
      }
      return changed;
    });
  }

  /** The most recent changes, newest first. */
  audit(limit = 50): SettingsAuditEntry[] {
    const rows = this.db
      .prepare("SELECT id, key, old_value, new_value, changed_at, actor FROM settings_audit ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as { id: number; key: string; old_value: string | null; new_value: string | null; changed_at: string; actor: string }[];
    const parse = (text: string | null) => (text === null ? null : (JSON.parse(text) as unknown));
    return rows.map((row) => ({ id: row.id, key: row.key, oldValue: parse(row.old_value), newValue: parse(row.new_value), changedAt: row.changed_at, actor: row.actor }));
  }

  #forAudit(key: string, json: string | null): string | null {
    if (json === null || !this.#secretKeys.has(key)) return json;
    return JSON.stringify(SECRET_MASK);
  }
}
