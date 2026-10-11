import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { emptyCheckpoint, uuid6, type Checkpoint, type CheckpointMetadata, type CheckpointTuple } from "@langchain/langgraph-checkpoint";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRAFT_PROMPT } from "../src/graph/escalate.js";
import { askAgent, buildGraph, resumeAgent, type AgentTurn } from "../src/graph/graph.js";
import { ROUTER_PROMPT } from "../src/graph/router.js";
import type { ReviewDecision } from "../src/graph/state.js";
import type { Llm } from "../src/llm.js";
import { PendingStore } from "../src/pending/store.js";
import { SqliteCheckpointSaver } from "../src/persistence/sqlite-checkpointer.js";
import { applyMigrations, openDatabase } from "../src/persistence/sqlite.js";
import { buildIndexFromDocs } from "../src/rag/ingest.js";
import { Retriever, type VectorIndex } from "../src/rag/retriever.js";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";

let dir: string;
const opened: DatabaseSync[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sqlite-cp-"));
});

afterEach(async () => {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
  await rm(dir, { recursive: true, force: true });
});

function open(file = "nested/assistant.db"): DatabaseSync {
  const db = openDatabase(join(dir, file));
  opened.push(db);
  return db;
}

function checkpointAt(id: string, value: string): Checkpoint {
  return { ...emptyCheckpoint(), id, ts: "2026-10-11T00:00:00.000Z", channel_values: { value }, channel_versions: { value: 1 } };
}

const meta = (step: number, extra: Record<string, unknown> = {}): CheckpointMetadata =>
  ({ source: "loop", step, parents: {}, ...extra }) as CheckpointMetadata;

/** JSON round-trip so tuples from both savers compare as plain data. */
const plain = (tuple: CheckpointTuple | undefined) => (tuple === undefined ? undefined : JSON.parse(JSON.stringify(tuple)));

async function collect(gen: AsyncGenerator<CheckpointTuple>) {
  const out = [];
  for await (const tuple of gen) out.push(plain(tuple));
  return out;
}

/** Runs one scenario against a saver and returns everything observable, so MemorySaver and SQLite can be compared. */
async function scenario(saver: BaseCheckpointSaver, ids: string[]) {
  const [a, b, c, d] = ids as [string, string, string, string];
  const t1 = { configurable: { thread_id: "t1", checkpoint_ns: "" } };
  const cfgA = await saver.put(t1, checkpointAt(a, "a"), meta(-1, { source: "input" }), {});
  const cfgB = await saver.put(cfgA, checkpointAt(b, "b"), meta(0), {});
  const cfgC = await saver.put(cfgB, checkpointAt(c, "c"), meta(1, { score: 7 }), {});
  await saver.put({ configurable: { thread_id: "t1", checkpoint_ns: "child" } }, checkpointAt(d, "sub"), meta(0), {});
  await saver.put({ configurable: { thread_id: "t2", checkpoint_ns: "" } }, checkpointAt(d, "other"), meta(0), {});

  await saver.putWrites(cfgC, [["value", "x"], ["__interrupt__", [{ value: { question: "q" }, id: "i1" }]]], "task-1");
  await saver.putWrites(cfgC, [["value", "ignored duplicate"]], "task-1");
  await saver.putWrites(cfgC, [["__interrupt__", [{ value: "replaced", id: "i2" }]]], "task-1");
  await saver.putWrites(cfgC, [["__error__", "boom"], ["other", { n: 1 }]], "task-2");

  const result = {
    latest: plain(await saver.getTuple({ configurable: { thread_id: "t1" } })),
    byId: plain(await saver.getTuple({ configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: a } })),
    child: plain(await saver.getTuple({ configurable: { thread_id: "t1", checkpoint_ns: "child" } })),
    missingThread: plain(await saver.getTuple({ configurable: { thread_id: "nope" } })),
    missingId: plain(await saver.getTuple({ configurable: { thread_id: "t1", checkpoint_id: "nope" } })),
    listThreadNs: await collect(saver.list({ configurable: { thread_id: "t1", checkpoint_ns: "" } })),
    listLimit: await collect(saver.list({ configurable: { thread_id: "t1", checkpoint_ns: "" } }, { limit: 2 })),
    listBefore: await collect(saver.list({ configurable: { thread_id: "t1", checkpoint_ns: "" } }, { before: { configurable: { checkpoint_id: c } } })),
    listFilter: await collect(saver.list({ configurable: { thread_id: "t1" } }, { filter: { score: 7 } })),
    listFilterSource: await collect(saver.list({ configurable: { thread_id: "t1", checkpoint_ns: "" } }, { filter: { source: "loop" }, limit: 1 })),
    listById: await collect(saver.list({ configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: b } })),
  };
  await saver.deleteThread("t1");
  return {
    ...result,
    afterDelete: plain(await saver.getTuple({ configurable: { thread_id: "t1" } })),
    otherThreadKept: plain(await saver.getTuple({ configurable: { thread_id: "t2" } })),
  };
}

describe("SqliteCheckpointSaver (unit, compared with MemorySaver)", () => {
  it("behaves like MemorySaver for put/getTuple/list/putWrites/namespaces/deleteThread", async () => {
    const ids = [uuid6(-1), uuid6(-1), uuid6(-1), uuid6(-1)].sort();
    const expected = await scenario(new MemorySaver(), ids);
    const actual = await scenario(new SqliteCheckpointSaver(open()), ids);
    expect(actual).toEqual(expected);

    // Spot-check the semantics themselves, not only the parity.
    expect(actual.latest.checkpoint.channel_values).toEqual({ value: "c" });
    expect(actual.latest.parentConfig.configurable.checkpoint_id).toBe(ids[1]);
    expect(actual.latest.pendingWrites).toEqual([
      ["task-1", "value", "x"],
      ["task-1", "__interrupt__", [{ value: "replaced", id: "i2" }]],
      ["task-2", "__error__", "boom"],
      ["task-2", "other", { n: 1 }],
    ]);
    expect(actual.listThreadNs.map((t: CheckpointTuple) => t.checkpoint.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(actual.listLimit).toHaveLength(2);
    expect(actual.listBefore.map((t: CheckpointTuple) => t.checkpoint.id)).toEqual([ids[1], ids[0]]);
    expect(actual.listFilter.map((t: CheckpointTuple) => t.checkpoint.id)).toEqual([ids[2]]);
    expect(actual.child.checkpoint.channel_values).toEqual({ value: "sub" });
    expect(actual.afterDelete).toBeUndefined();
    expect(actual.otherThreadKept.checkpoint.channel_values).toEqual({ value: "other" });
  });

  it("requires a thread_id to write, like MemorySaver", async () => {
    const saver = new SqliteCheckpointSaver(open());
    await expect(saver.put({ configurable: {} }, checkpointAt(uuid6(-1), "x"), meta(0), {})).rejects.toThrow(/thread_id/);
    await expect(saver.putWrites({ configurable: { thread_id: "t" } }, [], "task")).rejects.toThrow(/checkpoint_id/);
  });

  it("keeps data after the database file is closed and reopened", async () => {
    const id = uuid6(-1);
    const first = open("reopen.db");
    const config = await new SqliteCheckpointSaver(first).put({ configurable: { thread_id: "t" } }, checkpointAt(id, "kept"), meta(0), {});
    await new SqliteCheckpointSaver(first).putWrites(config, [["value", { deep: [1, 2] }]], "task");
    first.close();

    const tuple = await new SqliteCheckpointSaver(open("reopen.db")).getTuple({ configurable: { thread_id: "t" } });
    expect(tuple?.checkpoint.channel_values).toEqual({ value: "kept" });
    expect(tuple?.pendingWrites).toEqual([["task", "value", { deep: [1, 2] }]]);
  });

  it("lets other modules register their own tables, applying each migration once", () => {
    const db = open(":memory:");
    const module = { name: "jobs", migrations: ["CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT NOT NULL)"] };
    applyMigrations(db, module);
    applyMigrations(db, module);
    db.prepare("INSERT INTO jobs (status) VALUES (?)").run("queued");
    applyMigrations(db, { ...module, migrations: [...module.migrations, "ALTER TABLE jobs ADD COLUMN note TEXT"] });
    expect(db.prepare("SELECT status, note FROM jobs").all()).toEqual([{ status: "queued", note: null }]);
  });
});

describe("SqliteCheckpointSaver with the agent graph (restart)", () => {
  const embedder = new FakeEmbedder();
  let index: VectorIndex;

  beforeEach(async () => {
    index = await buildIndexFromDocs(
      [{ source: "cdn.md", markdown: "# CDN\n\n## Manifiesto\n\nEl manifiesto de versiones del CDN define qué bundle carga cada componente." }],
      embedder,
    );
  });

  const llm: Llm = async (system) => {
    if (system === ROUTER_PROMPT) return JSON.stringify({ route: "sensitive", topic: "cdn", reason: "test" });
    if (system === DRAFT_PROMPT) return "Borrador: no ejecutar; confirmar con la persona responsable.";
    throw new Error("unexpected prompt");
  };

  const graphWith = (checkpointer: BaseCheckpointSaver, pending: PendingStore) =>
    buildGraph({ llm, retriever: new Retriever(index, embedder, { docSlots: 2, minScore: 0.3 }), tools: new MockToolProvider(), pending }, checkpointer);

  const QUESTION = "Necesito que actualices el manifiesto de producción ya";

  /** Reference: pause and resume on one in-memory graph. */
  async function inMemory(decision: ReviewDecision) {
    const pending = new PendingStore(join(dir, `memory-${decision.approved}.json`));
    const graph = graphWith(new MemorySaver(), pending);
    const paused = await askAgent(graph, QUESTION, "job-1");
    const resumed = await resumeAgent(graph, decision, "job-1");
    return { paused, resumed, pending: await pending.list() };
  }

  /** Pauses on graph A, closes its database, then resumes from a new saver + graph over the same file. */
  async function acrossRestart(decision: ReviewDecision) {
    const file = `restart-${decision.approved}.db`;
    const pending = new PendingStore(join(dir, `sqlite-${decision.approved}.json`));
    const dbA = open(file);
    const paused = await askAgent(graphWith(new SqliteCheckpointSaver(dbA), pending), QUESTION, "job-1");
    dbA.close();

    const graphB = graphWith(new SqliteCheckpointSaver(open(file)), pending);
    const resumed = await resumeAgent(graphB, decision, "job-1");
    return { paused, resumed, pending: await pending.list() };
  }

  const comparable = (turn: AgentTurn) => ({ state: turn.state, review: turn.review });
  const decisions = (entries: Awaited<ReturnType<PendingStore["list"]>>) => entries.map(({ reason, decision, note }) => ({ reason, decision, note }));

  for (const decision of [{ approved: true }, { approved: false, note: "Esperar a la vuelta" }] satisfies ReviewDecision[]) {
    it(`resumes a paused job on a fresh graph instance (${decision.approved ? "approve" : "reject"})`, async () => {
      const reference = await inMemory(decision);
      const restarted = await acrossRestart(decision);

      expect(restarted.paused.review?.draft).toContain("Borrador");
      expect(comparable(restarted.paused)).toEqual(comparable(reference.paused));
      expect(comparable(restarted.resumed)).toEqual(comparable(reference.resumed));
      expect(restarted.resumed.review).toBeUndefined();
      expect(restarted.resumed.state.outcome).toBe(decision.approved ? "approved" : "rejected");
      expect(restarted.pending).toHaveLength(1);
      expect(decisions(restarted.pending)).toEqual(decisions(reference.pending));
    });
  }

  it("resuming a thread that does not exist behaves like MemorySaver", async () => {
    const run = async (checkpointer: BaseCheckpointSaver) => {
      const pending = new PendingStore(join(dir, `ghost-${checkpointer.constructor.name}.json`));
      try {
        const turn = await resumeAgent(graphWith(checkpointer, pending), { approved: true }, "ghost");
        return { ok: comparable(turn), pending: (await pending.list()).length };
      } catch (error) {
        return { error: (error as Error).message, pending: (await pending.list()).length };
      }
    };
    expect(await run(new SqliteCheckpointSaver(open()))).toEqual(await run(new MemorySaver()));
  });
});
