import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationTurn } from "../src/graph/state.js";
import { SqliteConversationMemory } from "../src/persistence/sqlite-memory.js";
import { openDatabase } from "../src/persistence/sqlite.js";

let dir: string;
const opened: DatabaseSync[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sqlite-memory-"));
});

afterEach(async () => {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
  await rm(dir, { recursive: true, force: true });
});

function open(): DatabaseSync {
  const db = openDatabase(join(dir, "assistant.db"));
  opened.push(db);
  return db;
}

const toolTurn: ConversationTurn = {
  question: "¿Qué pipelines fallaron?",
  route: "task",
  answer: "Falló acme-card-elements.",
  toolResults: [{ tool: "list_failed_pipelines", args: { sinceDays: 7 }, readOnly: true, result: [{ pipeline: "acme-card-elements", n: 1 }] }],
};

describe("SqliteConversationMemory", () => {
  it("keeps the last N turns per conversation, oldest first", async () => {
    const memory = new SqliteConversationMemory(open(), 2);
    for (const q of ["q1", "q2", "q3"]) await memory.append("ana", { question: q, answer: `a-${q}`, toolResults: [] });
    await memory.append("beto", { question: "otra", answer: "x", toolResults: [] });
    expect((await memory.recent("ana")).map((t) => t.question)).toEqual(["q2", "q3"]);
    expect((await memory.recent("beto")).map((t) => t.question)).toEqual(["otra"]);
    expect(await memory.recent("nadie")).toEqual([]);
  });

  it("stores nothing when disabled with 0 turns", async () => {
    const memory = new SqliteConversationMemory(open(), 0);
    await memory.append("ana", { question: "q", answer: "a", toolResults: [] });
    expect(await memory.recent("ana")).toEqual([]);
  });

  it("round-trips turns with tool results and survives a reopen", async () => {
    const db = open();
    await new SqliteConversationMemory(db).append("ana", toolTurn);
    db.close();
    expect(await new SqliteConversationMemory(open()).recent("ana")).toEqual([toolTurn]);
  });

  it("applies a smaller limit to turns stored under a larger one", async () => {
    const db = open();
    const wide = new SqliteConversationMemory(db, 6);
    for (const q of ["q1", "q2", "q3"]) await wide.append("ana", { question: q, answer: "a", toolResults: [] });
    expect((await new SqliteConversationMemory(db, 2).recent("ana")).map((t) => t.question)).toEqual(["q2", "q3"]);
  });
});
