import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ReviewDecision, Route } from "../graph/state.js";
import type { JobStatus, JobView } from "../service/assistant-service.js";
import { applyMigrations, transaction, type SchemaModule } from "./sqlite.js";

/** Everything the service keeps about a job; `JobView` is the public subset. */
export interface JobRecord extends JobView {
  /** LangGraph thread of the current attempt. */
  threadId: string;
  /** Memory and ordering key; absent for anonymous requests (no memory, no ordering). */
  conversationId?: string;
  /** Set when the human backup decides; the resumed step logs it as a `decision` line. */
  decision?: ReviewDecision;
  /** 1 for the first run; incremented when an interrupted ask is re-run on a fresh thread after a restart. */
  attempt: number;
}

export type JobPatch = Partial<Omit<JobRecord, "id" | "createdAt">>;

/**
 * Durable state of the assistant's jobs. Synchronous on purpose: approve/reject answer synchronously, and the
 * status flip that guards a resume must be committed before the resume is scheduled.
 */
export interface JobStore {
  /** Allocates the next id (monotonic, never reused) and stores the job built for it. */
  create(build: (id: number) => JobRecord): JobRecord;
  get(id: number): JobRecord | undefined;
  /** All jobs, oldest first. */
  list(): JobRecord[];
  /** Jobs still `queued` or `running`, oldest first. */
  unfinished(): JobRecord[];
  update(id: number, patch: JobPatch): void;
  /** Atomic check-and-set: applies `patch` only if the job is currently `from`; returns the updated job, or undefined. */
  transition(id: number, from: JobStatus, patch: JobPatch): JobRecord | undefined;
}

const copy = (job: JobRecord): JobRecord => structuredClone(job);

/** Process-local store (tests, or running without a database). */
export class InMemoryJobStore implements JobStore {
  readonly #jobs = new Map<number, JobRecord>();
  #lastId = 0;

  create(build: (id: number) => JobRecord): JobRecord {
    const job = copy(build(++this.#lastId));
    this.#jobs.set(job.id, job);
    return copy(job);
  }

  get(id: number): JobRecord | undefined {
    const job = this.#jobs.get(id);
    return job && copy(job);
  }

  list(): JobRecord[] {
    return [...this.#jobs.values()].map(copy);
  }

  unfinished(): JobRecord[] {
    return this.list().filter((job) => job.status === "queued" || job.status === "running");
  }

  update(id: number, patch: JobPatch): void {
    const job = this.#jobs.get(id);
    if (job) Object.assign(job, structuredClone(patch));
  }

  transition(id: number, from: JobStatus, patch: JobPatch): JobRecord | undefined {
    const job = this.#jobs.get(id);
    if (!job || job.status !== from) return undefined;
    Object.assign(job, structuredClone(patch));
    return copy(job);
  }
}

export const JOB_SCHEMA: SchemaModule = {
  name: "jobs",
  migrations: [
    `CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      question TEXT NOT NULL,
      requester TEXT,
      conversation_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'needs_approval', 'done', 'failed')),
      thread_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      route TEXT,
      answer TEXT,
      draft TEXT,
      error TEXT,
      decision TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX jobs_status ON jobs (status, id);
    CREATE TABLE job_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO job_meta (key, value) VALUES ('last_job_id', 0);`,
  ],
};

interface JobRow {
  id: number;
  question: string;
  requester: string | null;
  conversation_id: string | null;
  status: JobStatus;
  thread_id: string;
  attempt: number;
  route: string | null;
  answer: string | null;
  draft: string | null;
  error: string | null;
  decision: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, question, requester, conversation_id, status, thread_id, attempt, route, answer, draft, error, decision, created_at, updated_at";
const SET_COLUMNS =
  "question = ?, requester = ?, conversation_id = ?, status = ?, thread_id = ?, attempt = ?, route = ?, answer = ?, draft = ?, error = ?, decision = ?, updated_at = ?";

/** Values for `SET_COLUMNS`, in order. */
function setValues(job: JobRecord): SQLInputValue[] {
  return [
    job.question,
    job.requester ?? null,
    job.conversationId ?? null,
    job.status,
    job.threadId,
    job.attempt,
    job.route ?? null,
    job.answer ?? null,
    job.draft ?? null,
    job.error ?? null,
    job.decision ? JSON.stringify(job.decision) : null,
    job.updatedAt,
  ];
}

function fromRow(row: JobRow): JobRecord {
  const job: JobRecord = {
    id: row.id,
    question: row.question,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    threadId: row.thread_id,
    attempt: row.attempt,
  };
  if (row.requester !== null) job.requester = row.requester;
  if (row.conversation_id !== null) job.conversationId = row.conversation_id;
  if (row.route !== null) job.route = row.route as Route;
  if (row.answer !== null) job.answer = row.answer;
  if (row.draft !== null) job.draft = row.draft;
  if (row.error !== null) job.error = row.error;
  if (row.decision !== null) job.decision = JSON.parse(row.decision) as ReviewDecision;
  return job;
}

/**
 * Jobs in the shared SQLite database. Every write is one `BEGIN IMMEDIATE` transaction, so check-and-set
 * transitions are atomic across connections and processes. The caller owns the database handle.
 */
export class SqliteJobStore implements JobStore {
  constructor(readonly db: DatabaseSync) {
    applyMigrations(db, JOB_SCHEMA);
  }

  create(build: (id: number) => JobRecord): JobRecord {
    return transaction(this.db, () => {
      const { value } = this.db.prepare("UPDATE job_meta SET value = value + 1 WHERE key = 'last_job_id' RETURNING value").get() as { value: number };
      const job = build(value);
      this.db
        .prepare(`INSERT INTO jobs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(job.id, ...setValues(job).slice(0, -1), job.createdAt, job.updatedAt);
      return copy(job);
    });
  }

  get(id: number): JobRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
    return row && fromRow(row);
  }

  list(): JobRecord[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM jobs ORDER BY id`).all() as unknown as JobRow[]).map(fromRow);
  }

  unfinished(): JobRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE status IN ('queued', 'running') ORDER BY id`).all() as unknown as JobRow[];
    return rows.map(fromRow);
  }

  update(id: number, patch: JobPatch): void {
    transaction(this.db, () => {
      const job = this.get(id);
      if (job) this.db.prepare(`UPDATE jobs SET ${SET_COLUMNS} WHERE id = ?`).run(...setValues({ ...job, ...patch }), id);
    });
  }

  transition(id: number, from: JobStatus, patch: JobPatch): JobRecord | undefined {
    return transaction(this.db, () => {
      const job = this.get(id);
      if (!job || job.status !== from) return undefined;
      const next = { ...job, ...patch };
      // The status guard in the WHERE clause keeps the write conditional even without the surrounding lock.
      const { changes } = this.db.prepare(`UPDATE jobs SET ${SET_COLUMNS} WHERE id = ? AND status = ?`).run(...setValues(next), id, from);
      return Number(changes) === 1 ? copy(next) : undefined;
    });
  }
}
