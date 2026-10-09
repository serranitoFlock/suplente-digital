import { EventEmitter } from "node:events";
import { askAgent, resumeAgent, tracedTurn, type AgentGraph, type AgentTurn } from "../graph/graph.js";
import type { Tracer } from "../observability/tracing.js";
import { detectSensitive } from "../graph/router.js";
import type { ReviewDecision, Route } from "../graph/state.js";
import { JobQueue } from "./job-queue.js";

/**
 * Transport-agnostic front door for the assistant: `submit()` answers instantly with a
 * deterministic acknowledgement (no model call) and the graph runs in a background queue.
 * Results arrive as events, so any adapter (CLI, Teams, Slack) can deliver them as a
 * follow-up message whenever they are ready.
 */

/** What the service needs from the agent graph; tests plug in a fake. */
export interface AgentRunner {
  ask(question: string, threadId: string): Promise<AgentTurn>;
  resume(decision: ReviewDecision, threadId: string): Promise<AgentTurn>;
}

/** Adapts the graph to the service; with a tracer, every ask/resume becomes one trace. */
export function graphRunner(graph: AgentGraph, tracer?: Tracer): AgentRunner {
  return {
    ask: (question, threadId) => tracedTurn(tracer, threadId, "ask", () => askAgent(graph, question, threadId)),
    resume: (decision, threadId) => tracedTurn(tracer, threadId, "resume", () => resumeAgent(graph, decision, threadId)),
  };
}

export type JobStatus = "queued" | "running" | "needs_approval" | "done" | "failed";

export interface JobView {
  id: number;
  question: string;
  requester?: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  route?: Route;
  answer?: string;
  draft?: string;
  error?: string;
}

interface JobEventBase {
  id: number;
  question: string;
  requester?: string;
}

export interface DoneEvent extends JobEventBase {
  route?: Route;
  answer: string;
}

export interface NeedsApprovalEvent extends JobEventBase {
  draft: string;
}

export interface FailedEvent extends JobEventBase {
  /** Friendly Spanish text, safe to show to the requester. */
  message: string;
  /** Technical detail for logs; never shown to the requester. */
  error: string;
}

export interface AssistantEvents {
  done: [DoneEvent];
  needs_approval: [NeedsApprovalEvent];
  failed: [FailedEvent];
}

export type DecisionResult = "accepted" | "not_found" | "not_pending";

export interface AssistantServiceOptions {
  /** Max graph runs at once (default 1: local models usually serve one request at a time). */
  concurrency?: number;
  /** Prefix for LangGraph thread ids, so several services can share one checkpointer. */
  threadPrefix?: string;
}

/** Parses `ASSISTANT_CONCURRENCY`; default 1. */
export function resolveConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`ASSISTANT_CONCURRENCY must be a positive integer, got "${raw}".`);
  }
  return value;
}

const LIVE_LOOKUP_HINT = /\b(ticket|tickets|pipelines?|jobs?|[A-Z][A-Z0-9]+-\d+)\b/u;

/** Deterministic acknowledgement; uses cheap keyword hints only, never the model. */
export function buildAck(id: number, text: string, ahead: number): string {
  const hint = detectSensitive(text)
    ? "Parece un pedido que necesita aprobación del backup humano: preparo un borrador y te aviso"
    : LIVE_LOOKUP_HINT.test(text)
      ? "Estoy consultando los sistemas (solo lectura) y te respondo en cuanto lo tenga"
      : "Lo estoy revisando y te respondo en cuanto lo tenga";
  const queue = ahead > 0 ? ` Hay ${ahead} ${ahead === 1 ? "consulta" : "consultas"} antes que la tuya.` : "";
  return `Recibido 👀 (consulta #${id}). ${hint}.${queue}`;
}

function failureMessage(id: number): string {
  return `No pude procesar la consulta #${id} por un problema técnico. Probá de nuevo en unos minutos o escribile al backup humano.`;
}

interface Job extends JobView {
  threadId: string;
}

export class AssistantService extends EventEmitter<AssistantEvents> {
  readonly #runner: AgentRunner;
  readonly #queue: JobQueue;
  readonly #threadPrefix: string;
  readonly #jobs = new Map<number, Job>();
  #lastId = 0;

  constructor(runner: AgentRunner, options: AssistantServiceOptions = {}) {
    super();
    this.#runner = runner;
    this.#queue = new JobQueue(options.concurrency ?? 1);
    this.#threadPrefix = options.threadPrefix ?? `job-${Date.now()}`;
  }

  /** Accepts a request and returns its acknowledgement immediately; the work runs in the background. */
  submit(text: string, { requester }: { requester?: string } = {}): { id: number; ack: string } {
    const id = ++this.#lastId;
    const now = new Date().toISOString();
    const job: Job = { id, question: text, requester, status: "queued", createdAt: now, updatedAt: now, threadId: `${this.#threadPrefix}-${id}` };
    this.#jobs.set(id, job);

    const ahead = this.#queue.active >= this.#queue.concurrency ? this.#queue.active + this.#queue.waiting : 0;
    this.#schedule(job, () => this.#runner.ask(text, job.threadId));
    return { id, ack: buildAck(id, text, ahead) };
  }

  /** Resumes a job paused for human review. The bot still never executes the action itself. */
  approve(id: number, note?: string): DecisionResult {
    return this.#decide(id, { approved: true, note });
  }

  reject(id: number, note?: string): DecisionResult {
    return this.#decide(id, { approved: false, note });
  }

  status(id: number): JobView | undefined {
    const job = this.#jobs.get(id);
    return job && toView(job);
  }

  list(): JobView[] {
    return [...this.#jobs.values()].map(toView);
  }

  /** Resolves when no job is queued or running (jobs waiting for approval do not count). */
  idle(): Promise<void> {
    return this.#queue.onIdle();
  }

  #decide(id: number, decision: ReviewDecision): DecisionResult {
    const job = this.#jobs.get(id);
    if (!job) return "not_found";
    if (job.status !== "needs_approval") return "not_pending";
    // Flip the status synchronously so a second approve/reject cannot resume (and log) twice.
    this.#update(job, { status: "queued" });
    this.#schedule(job, () => this.#runner.resume(decision, job.threadId));
    return "accepted";
  }

  #schedule(job: Job, step: () => Promise<AgentTurn>): void {
    this.#queue
      .run(() => this.#process(job, step))
      .catch((error: unknown) => {
        // Only reachable if an event listener throws; keep the queue alive and surface it.
        console.error(`Assistant listener error (job #${job.id}):`, error);
      });
  }

  async #process(job: Job, step: () => Promise<AgentTurn>): Promise<void> {
    this.#update(job, { status: "running" });
    let turn: AgentTurn;
    try {
      turn = await step();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#update(job, { status: "failed", error: detail });
      this.emit("failed", { ...eventBase(job), message: failureMessage(job.id), error: detail });
      return;
    }

    if (turn.review) {
      this.#update(job, { status: "needs_approval", route: turn.state.route, draft: turn.review.draft });
      this.emit("needs_approval", { ...eventBase(job), draft: turn.review.draft });
      return;
    }
    const answer = turn.state.answer ?? "";
    this.#update(job, { status: "done", route: turn.state.route, answer });
    this.emit("done", { ...eventBase(job), route: turn.state.route, answer });
  }

  #update(job: Job, patch: Partial<JobView>): void {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  }
}

function eventBase({ id, question, requester }: Job): JobEventBase {
  return { id, question, requester };
}

function toView({ threadId: _threadId, ...view }: Job): JobView {
  return { ...view };
}
