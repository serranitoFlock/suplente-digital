import type { AgentTurn } from "../../src/graph/graph.js";
import type { ConversationTurn, ReviewDecision, State } from "../../src/graph/state.js";
import type { AgentRunner, AssistantService, DoneEvent, FailedEvent, NeedsApprovalEvent } from "../../src/service/assistant-service.js";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const baseState = { history: [], reference: { kind: "none" as const }, toolCalls: [], citedSources: [] };

export const answered = (answer: string, route: State["route"] = "question", toolCalls: State["toolCalls"] = []): AgentTurn => ({
  state: { ...baseState, question: "", route, topic: "t", routeReason: "", answer, sources: [], draft: "", outcome: "answered", toolCalls },
});

export const needsReview = (draft: string): AgentTurn => ({
  state: { ...baseState, question: "", route: "sensitive", topic: "t", routeReason: "", answer: "", sources: [], draft, outcome: undefined as never },
  review: { question: "q", draft },
});

/** Fake graph: every ask waits on a deferred the test controls; resumes answer at once. */
export class ControlledRunner implements AgentRunner {
  readonly asks = new Map<string, Deferred<AgentTurn>>();
  readonly histories = new Map<string, ConversationTurn[] | undefined>();
  /** Thread id of the latest ask per question. */
  readonly threadIds = new Map<string, string>();
  readonly resumes: { threadId: string; decision: ReviewDecision }[] = [];
  resumeTurn: (decision: ReviewDecision) => AgentTurn = (d) => {
    const turn = answered(d.approved ? "aprobado" : "rechazado", "sensitive");
    turn.state.outcome = d.approved ? "approved" : "rejected";
    return turn;
  };
  active = 0;
  maxActive = 0;

  ask(question: string, threadId: string, history?: ConversationTurn[]): Promise<AgentTurn> {
    this.histories.set(question, history);
    this.threadIds.set(question, threadId);
    const d = deferred<AgentTurn>();
    this.asks.set(question, d);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    return d.promise.finally(() => this.active--);
  }

  async resume(decision: ReviewDecision, threadId: string): Promise<AgentTurn> {
    this.resumes.push({ threadId, decision });
    return this.resumeTurn(decision);
  }

  async release(question: string, turn: AgentTurn | Error): Promise<void> {
    await waitFor(() => this.asks.has(question));
    const d = this.asks.get(question)!;
    if (turn instanceof Error) d.reject(turn);
    else d.resolve(turn);
  }
}

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!condition()) throw new Error("condition not met");
}

export function nextEvent<K extends "done" | "failed" | "needs_approval">(service: AssistantService, name: K) {
  return new Promise<K extends "done" ? DoneEvent : K extends "failed" ? FailedEvent : NeedsApprovalEvent>((resolve) =>
    service.once(name, resolve as never),
  );
}
