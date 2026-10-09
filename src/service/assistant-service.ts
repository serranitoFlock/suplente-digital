import { EventEmitter } from "node:events";
import { askAgent, resumeAgent, tracedTurn, type AgentGraph, type AgentTurn } from "../graph/graph.js";
import type { Tracer } from "../observability/tracing.js";
import { detectSensitive } from "../graph/router.js";
import { sourceLabel } from "../graph/citations.js";
import type { ConversationTurn, ReviewDecision, Route } from "../graph/state.js";
import { InMemoryConversationMemory, toConversationTurn, type ConversationMemory } from "../memory/conversation-memory.js";
import { summarizeToolResult, type ConversationLogSink, type LogOutcome, type NewLogEntry } from "../logging/conversation-log.js";
import { formatAnswerForUser } from "../presentation/format-answer.js";
import { JobQueue } from "./job-queue.js";

/**
 * Transport-agnostic front door for the assistant: `submit()` answers instantly with a
 * deterministic acknowledgement (no model call) and the graph runs in a background queue.
 * Results arrive as events, so any adapter (CLI, Teams, Slack) can deliver them as a
 * follow-up message whenever they are ready.
 */

/** What the service needs from the agent graph; tests plug in a fake. */
export interface AgentRunner {
  /** `history`: the requester's recent turns, oldest first (short-term memory). */
  ask(question: string, threadId: string, history?: ConversationTurn[]): Promise<AgentTurn>;
  resume(decision: ReviewDecision, threadId: string): Promise<AgentTurn>;
}

/** Adapts the graph to the service; with a tracer, every ask/resume becomes one trace. */
export function graphRunner(graph: AgentGraph, tracer?: Tracer): AgentRunner {
  return {
    ask: (question, threadId, history) => tracedTurn(tracer, threadId, "ask", () => askAgent(graph, question, threadId, history)),
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
  /** User-facing text (citations shown or hidden according to `showCitations`). */
  answer: string;
  /** Full graph answer with `[n]` markers and the "Fuentes:" block (for logs and audits). */
  rawAnswer: string;
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
  /** Short-term memory per requester (default: in memory, last 6 turns). */
  memory?: ConversationMemory;
  /** Show `[n]` markers and the cited sources to the requester (`SHOW_CITATIONS`, default false). */
  showCitations?: boolean;
  /** Daily conversation log: one line per completed request and per approval decision. */
  log?: ConversationLogSink;
}

/** Conversation id used when a request has no requester (e.g. a single local CLI user). */
export const DEFAULT_REQUESTER = "local";

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
  /** Memory and ordering key; absent for anonymous requests (no memory, no ordering). */
  conversationId?: string;
  /** Set when the human backup decides; the resumed step logs it as a `decision` line. */
  decision?: ReviewDecision;
}

export class AssistantService extends EventEmitter<AssistantEvents> {
  readonly #runner: AgentRunner;
  readonly #queue: JobQueue;
  readonly #threadPrefix: string;
  readonly #memory: ConversationMemory;
  readonly #showCitations: boolean;
  readonly #log: ConversationLogSink | undefined;
  readonly #jobs = new Map<number, Job>();
  /** Last scheduled step per conversation: requests from the same requester run in order. */
  readonly #tails = new Map<string, Promise<void>>();
  #inFlight = 0;
  readonly #idleWaiters: (() => void)[] = [];
  #lastId = 0;

  constructor(runner: AgentRunner, options: AssistantServiceOptions = {}) {
    super();
    this.#runner = runner;
    this.#queue = new JobQueue(options.concurrency ?? 1);
    this.#threadPrefix = options.threadPrefix ?? `job-${Date.now()}`;
    this.#memory = options.memory ?? new InMemoryConversationMemory();
    this.#showCitations = options.showCitations ?? false;
    this.#log = options.log;
  }

  /** Accepts a request and returns its acknowledgement immediately; the work runs in the background. */
  submit(text: string, { requester }: { requester?: string } = {}): { id: number; ack: string } {
    const id = ++this.#lastId;
    const now = new Date().toISOString();
    const job: Job = {
      id,
      question: text,
      requester,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      threadId: `${this.#threadPrefix}-${id}`,
      conversationId: requester,
    };
    this.#jobs.set(id, job);

    const saturated = this.#queue.active >= this.#queue.concurrency;
    const behindOwnRequest = job.conversationId !== undefined && this.#tails.has(job.conversationId);
    const ahead = saturated || behindOwnRequest ? this.list().filter((j) => j.id !== id && (j.status === "queued" || j.status === "running")).length : 0;
    // History is read when the job starts, after earlier jobs of the same requester completed.
    this.#schedule(job, async () => this.#runner.ask(text, job.threadId, await this.#history(job)), { ordered: true });
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
    if (this.#inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #decide(id: number, decision: ReviewDecision): DecisionResult {
    const job = this.#jobs.get(id);
    if (!job) return "not_found";
    if (job.status !== "needs_approval") return "not_pending";
    // Flip the status synchronously so a second approve/reject cannot resume (and log) twice.
    this.#update(job, { status: "queued" });
    job.decision = decision;
    this.#schedule(job, () => this.#runner.resume(decision, job.threadId));
    return "accepted";
  }

  #schedule(job: Job, step: () => Promise<AgentTurn>, { ordered = false } = {}): void {
    this.#inFlight++;
    const key = ordered ? job.conversationId : undefined;
    const previous = key === undefined ? undefined : this.#tails.get(key);
    const enqueue = () => this.#queue.run(() => this.#process(job, step));
    // Enqueue synchronously when nothing of the same requester is pending, so queue stats stay exact.
    const run: Promise<void> = (previous ? previous.then(enqueue) : enqueue())
      .catch((error: unknown) => {
        // Only reachable if an event listener throws; keep the queue alive and surface it.
        console.error(`Assistant listener error (job #${job.id}):`, error);
      })
      .finally(() => {
        if (key !== undefined && this.#tails.get(key) === run) this.#tails.delete(key);
        if (--this.#inFlight === 0) for (const resolve of this.#idleWaiters.splice(0)) resolve();
      });
    if (key !== undefined) this.#tails.set(key, run);
  }

  async #history(job: Job): Promise<ConversationTurn[]> {
    if (job.conversationId === undefined) return [];
    try {
      return await this.#memory.recent(job.conversationId);
    } catch (error) {
      console.warn(`[memory] could not read history for job #${job.id}: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  async #process(job: Job, step: () => Promise<AgentTurn>): Promise<void> {
    this.#update(job, { status: "running" });
    const startedAt = Date.now();
    let turn: AgentTurn;
    try {
      turn = await step();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#update(job, { status: "failed", error: detail });
      await this.#writeLog(job, { outcome: "failed", latencyMs: Date.now() - startedAt, error: detail });
      this.emit("failed", { ...eventBase(job), message: failureMessage(job.id), error: detail });
      return;
    }
    const latencyMs = Date.now() - startedAt;

    if (turn.review) {
      this.#update(job, { status: "needs_approval", route: turn.state.route, draft: turn.review.draft });
      await this.#writeLog(job, { ...turnLogFields(turn), outcome: "approval_pending", draft: turn.review.draft, latencyMs });
      this.emit("needs_approval", { ...eventBase(job), draft: turn.review.draft });
      return;
    }
    const rawAnswer = turn.state.answer ?? "";
    const answer = formatAnswerForUser(rawAnswer, { showCitations: this.#showCitations });
    await this.#remember(job, turn);
    await this.#writeLog(job, { ...turnLogFields(turn), outcome: logOutcome(turn), answer: rawAnswer, latencyMs });
    this.#update(job, { status: "done", route: turn.state.route, answer });
    this.emit("done", { ...eventBase(job), route: turn.state.route, answer, rawAnswer });
  }

  /** Appends one daily-log line; a logging failure never fails the request. */
  async #writeLog(job: Job, fields: Partial<NewLogEntry> & Pick<NewLogEntry, "outcome" | "latencyMs">): Promise<void> {
    if (!this.#log) return;
    const decision = job.decision;
    try {
      await this.#log.append({
        event: decision ? "decision" : "request",
        requestId: job.id,
        requester: job.requester,
        question: job.question,
        citedSources: [],
        toolCalls: [],
        ...fields,
        ...(decision?.note ? { note: decision.note } : {}),
      });
    } catch (error) {
      console.warn(`[log] could not write the log line of job #${job.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Memory is appended only when a job completes, so a follow-up sees finished turns only. */
  async #remember(job: Job, turn: AgentTurn): Promise<void> {
    if (job.conversationId === undefined) return;
    try {
      await this.#memory.append(job.conversationId, toConversationTurn(job.question, turn));
    } catch (error) {
      console.warn(`[memory] could not store turn of job #${job.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  #update(job: Job, patch: Partial<JobView>): void {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  }
}

function logOutcome({ state }: AgentTurn): LogOutcome {
  switch (state.outcome) {
    case "unknown":
      return "no_se";
    case "clarify":
    case "refused":
    case "approved":
    case "rejected":
      return state.outcome;
    default:
      return "answered"; // answered, out_of_scope (polite decline; the route tells them apart)
  }
}

function turnLogFields(turn: AgentTurn): Partial<NewLogEntry> {
  const { state, trace } = turn;
  return {
    route: state.route,
    citedSources: (state.citedSources ?? []).map(sourceLabel),
    toolCalls: (state.toolCalls ?? []).map((call) => ({
      name: call.tool,
      args: call.args,
      readOnly: call.readOnly,
      ...(call.fromMemory ? { fromMemory: true } : {}),
      result: summarizeToolResult(call.result),
    })),
    ...(trace ? { traceId: trace.traceId, tokens: { input: trace.inputTokens, output: trace.outputTokens, reported: trace.usageReported } } : {}),
    ...(state.route === "refuse" ? { securityEvent: "refusal" as const } : {}),
  };
}

function eventBase({ id, question, requester }: Job): JobEventBase {
  return { id, question, requester };
}

function toView({ threadId: _threadId, conversationId: _conversationId, decision: _decision, ...view }: Job): JobView {
  return { ...view };
}
