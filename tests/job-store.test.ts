import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryJobStore, SqliteJobStore, type JobRecord, type JobStore } from "../src/persistence/job-store.js";
import { openDatabase } from "../src/persistence/sqlite.js";

let dir: string;
const opened: DatabaseSync[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "job-store-"));
});

afterEach(async () => {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
  await rm(dir, { recursive: true, force: true });
});

function sqliteStore(): SqliteJobStore {
  const db = openDatabase(join(dir, "assistant.db"));
  opened.push(db);
  return new SqliteJobStore(db);
}

const draft = (id: number, extra: Partial<JobRecord> = {}): JobRecord => ({
  id,
  question: `q${id}`,
  status: "queued",
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
  threadId: `job-${id}`,
  attempt: 1,
  ...extra,
});

const stores: [string, () => JobStore][] = [
  ["InMemoryJobStore", () => new InMemoryJobStore()],
  ["SqliteJobStore", sqliteStore],
];

for (const [name, make] of stores) {
  describe(name, () => {
    it("allocates increasing ids and round-trips every field", () => {
      const store = make();
      const a = store.create((id) => draft(id, { requester: "ana", conversationId: "ana" }));
      const b = store.create((id) => draft(id));
      expect([a.id, b.id]).toEqual([1, 2]);
      expect(store.get(1)).toEqual(draft(1, { requester: "ana", conversationId: "ana" }));
      expect(store.get(2)).toEqual(draft(2));
      expect(store.get(3)).toBeUndefined();
      expect(store.list().map((j) => j.id)).toEqual([1, 2]);
    });

    it("updates fields and lists unfinished jobs in id order", () => {
      const store = make();
      for (let i = 0; i < 3; i++) store.create((id) => draft(id));
      store.update(1, { status: "done", answer: "ok", route: "question", updatedAt: "later" });
      store.update(3, { status: "running" });
      expect(store.get(1)).toMatchObject({ status: "done", answer: "ok", route: "question", updatedAt: "later" });
      expect(store.unfinished().map((j) => [j.id, j.status])).toEqual([
        [2, "queued"],
        [3, "running"],
      ]);
    });

    it("applies a transition only from the expected status (check-and-set)", () => {
      const store = make();
      store.create((id) => draft(id, { status: "needs_approval" }));
      const decided = store.transition(1, "needs_approval", { status: "queued", decision: { approved: true, note: "ok" } });
      expect(decided).toMatchObject({ id: 1, status: "queued", decision: { approved: true, note: "ok" } });
      expect(store.transition(1, "needs_approval", { status: "queued", decision: { approved: false } })).toBeUndefined();
      expect(store.get(1)?.decision).toEqual({ approved: true, note: "ok" });
      expect(store.transition(9, "needs_approval", { status: "queued" })).toBeUndefined();
    });

    it("returns copies, so callers cannot mutate stored jobs", () => {
      const store = make();
      const job = store.create((id) => draft(id));
      job.status = "done";
      store.get(1)!.status = "failed";
      expect(store.get(1)?.status).toBe("queued");
    });
  });
}

describe("SqliteJobStore across connections", () => {
  it("keeps jobs and the id sequence across a reopen", () => {
    const first = sqliteStore();
    first.create((id) => draft(id));
    first.create((id) => draft(id));
    opened[0]!.close();
    const second = sqliteStore();
    expect(second.list().map((j) => j.id)).toEqual([1, 2]);
    expect(second.create((id) => draft(id)).id).toBe(3);
  });

  it("lets only one connection win the same transition", () => {
    const a = sqliteStore();
    const b = sqliteStore();
    a.create((id) => draft(id, { status: "needs_approval" }));
    expect(b.transition(1, "needs_approval", { status: "queued", decision: { approved: false } })).toBeDefined();
    expect(a.transition(1, "needs_approval", { status: "queued", decision: { approved: true } })).toBeUndefined();
    expect(a.get(1)?.decision).toEqual({ approved: false });
  });
});
