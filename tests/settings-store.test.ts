import { mkdtemp, rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_SCHEMA, SettingsStore } from "../src/persistence/settings-store.js";
import { openDatabase } from "../src/persistence/sqlite.js";

let dir: string;
let db: DatabaseSync;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "settings-store-"));
  db = openDatabase(join(dir, "assistant.db"), [SETTINGS_SCHEMA]);
});

afterEach(async () => {
  if (db.isOpen) db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("settings store", () => {
  it("is empty on a fresh database", () => {
    expect(new SettingsStore(db).entries().size).toBe(0);
  });

  it("stores JSON values with their update time and survives a reopen", () => {
    const store = new SettingsStore(db);
    expect(store.write({ "llm.model": "qwen3:8b", "llm.temperature": 0.2, "scripts.registry": { scripts: [] } })).toEqual(
      expect.arrayContaining(["llm.model", "llm.temperature", "scripts.registry"]),
    );
    db.close();
    db = openDatabase(join(dir, "assistant.db"), [SETTINGS_SCHEMA]);
    const entries = new SettingsStore(db).entries();
    expect(entries.get("llm.model")?.value).toBe("qwen3:8b");
    expect(entries.get("llm.temperature")?.value).toBe(0.2);
    expect(entries.get("scripts.registry")?.value).toEqual({ scripts: [] });
    expect(entries.get("llm.model")?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("deletes a key on null and reports only keys that actually changed", () => {
    const store = new SettingsStore(db);
    store.write({ "llm.model": "a" });
    expect(store.write({ "llm.model": "a" })).toEqual([]);
    expect(store.write({ "llm.model": null })).toEqual(["llm.model"]);
    expect(store.entries().has("llm.model")).toBe(false);
    expect(store.write({ "llm.model": null })).toEqual([]);
  });

  it("appends one audit row per change, newest first, with the actor", () => {
    const store = new SettingsStore(db);
    store.write({ "llm.model": "a" });
    store.write({ "llm.model": "b" });
    store.write({ "llm.model": null });
    const audit = store.audit();
    expect(audit.map((row) => [row.key, row.oldValue, row.newValue, row.actor])).toEqual([
      ["llm.model", "b", null, "admin"],
      ["llm.model", "a", "b", "admin"],
      ["llm.model", null, "a", "admin"],
    ]);
    expect(store.audit(1)).toHaveLength(1);
  });

  it("masks secrets in the audit and never writes their value there", () => {
    const store = new SettingsStore(db, { secretKeys: ["llm.anthropicApiKey"] });
    store.write({ "llm.anthropicApiKey": "sk-ant-very-secret" });
    store.write({ "llm.anthropicApiKey": "sk-ant-other-secret" });
    store.write({ "llm.anthropicApiKey": null });
    expect(store.audit().map((row) => [row.oldValue, row.newValue])).toEqual([
      ["***", null],
      ["***", "***"],
      [null, "***"],
    ]);
    const raw = JSON.stringify(db.prepare("SELECT * FROM settings_audit").all());
    expect(raw).not.toContain("secret");
  });
});
