import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Lightweight in-process tracing: one trace per request, spans per graph node and per LLM/tool call.
 * Attribute names follow the OpenTelemetry GenAI semantic conventions
 * (https://github.com/open-telemetry/semantic-conventions-genai) so an OTel or Langfuse exporter
 * can be plugged in later through `TraceExporter` without renaming anything.
 *
 * Privacy: spans carry metadata only (ids, timings, model, tokens, route). Prompts, retrieved text
 * and replies are never recorded (content capture is opt-in in the OTel conventions too).
 */

export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** Clock reading at span start (ms; epoch time with the default clock). */
  startTimeMs: number;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
  attributes: Attributes;
}

export interface TraceSummary {
  traceId: string;
  name: string;
  durationMs: number;
  route?: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** False when at least one LLM call did not report token usage (token totals are then a lower bound). */
  usageReported: boolean;
  costUsd: number;
}

export interface TraceRecord {
  traceId: string;
  name: string;
  durationMs: number;
  /** Root span first, then children in completion order. */
  spans: SpanRecord[];
  summary: TraceSummary;
}

/** Destination for finished traces (JSONL today; OTel / Langfuse later). Must not throw into the request path. */
export interface TraceExporter {
  export(trace: TraceRecord): Promise<void> | void;
}

export class InMemoryTraceExporter implements TraceExporter {
  readonly traces: TraceRecord[] = [];
  export(trace: TraceRecord): void {
    this.traces.push(trace);
  }
}

/** Appends one JSON object per line. Writes are serialized so concurrent requests never interleave. */
export class JsonlTraceExporter implements TraceExporter {
  #writes: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  export(trace: TraceRecord): Promise<void> {
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(trace)}\n`);
    });
    return this.#writes;
  }
}

export interface CostRates {
  /** USD per million input tokens (`LLM_COST_INPUT_PER_MTOK`, default 0 for a local model). */
  inputPerMTok: number;
  /** USD per million output tokens (`LLM_COST_OUTPUT_PER_MTOK`, default 0). */
  outputPerMTok: number;
}

export function estimateCost(usage: { inputTokens: number; outputTokens: number }, rates: CostRates): number {
  return (usage.inputTokens / 1_000_000) * rates.inputPerMTok + (usage.outputTokens / 1_000_000) * rates.outputPerMTok;
}

/** Reads cost rates from the environment. No vendor prices are hardcoded: unset means 0. */
export function resolveCostRates(env: Record<string, string | undefined>): CostRates {
  const read = (name: string): number => {
    const raw = env[name]?.trim();
    if (!raw) return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number (USD per million tokens), got "${raw}".`);
    return value;
  };
  return { inputPerMTok: read("LLM_COST_INPUT_PER_MTOK"), outputPerMTok: read("LLM_COST_OUTPUT_PER_MTOK") };
}

/** Handle for adding attributes to the span that is currently running. */
export interface ActiveSpan {
  setAttributes(attributes: Attributes): void;
}

interface TraceState {
  traceId: string;
  clock: () => number;
  spans: SpanRecord[];
}

interface Context {
  trace: TraceState;
  spanId: string;
}

const storage = new AsyncLocalStorage<Context>();
const NOOP_SPAN: ActiveSpan = { setAttributes: () => undefined };
const newId = (bytes: number) => randomBytes(bytes).toString("hex");

export interface SpanOptions {
  /** Errors that are control flow, not failures (e.g. a LangGraph interrupt); the span stays "ok". */
  isExpectedError?: (error: unknown) => boolean;
}

async function runSpan<T>(
  trace: TraceState,
  parentSpanId: string | undefined,
  name: string,
  attributes: Attributes,
  fn: (span: ActiveSpan) => Promise<T>,
  options: SpanOptions,
): Promise<{ result?: T; span: SpanRecord; error?: unknown; failed: boolean }> {
  const start = trace.clock();
  const span: SpanRecord = { traceId: trace.traceId, spanId: newId(8), parentSpanId, name, startTimeMs: start, durationMs: 0, status: "ok", attributes: { ...attributes } };
  const handle: ActiveSpan = { setAttributes: (attrs) => Object.assign(span.attributes, attrs) };
  try {
    const result = await storage.run({ trace, spanId: span.spanId }, () => fn(handle));
    return { result, span, failed: false };
  } catch (error) {
    if (!options.isExpectedError?.(error)) {
      span.status = "error";
      span.error = error instanceof Error ? error.message : String(error);
    }
    return { span, error, failed: true };
  } finally {
    span.durationMs = trace.clock() - start;
    if (parentSpanId !== undefined) trace.spans.push(span);
  }
}

/** Runs `fn` inside a child span of the current trace; a plain call when no trace is active. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: ActiveSpan) => Promise<T>, options: SpanOptions = {}): Promise<T> {
  const context = storage.getStore();
  if (!context) return fn(NOOP_SPAN);
  const outcome = await runSpan(context.trace, context.spanId, name, attributes, fn, options);
  if (outcome.failed) throw outcome.error;
  return outcome.result as T;
}

export interface TracerOptions {
  exporters?: TraceExporter[];
  /** Milliseconds; injectable for tests. Defaults to `Date.now`. */
  clock?: () => number;
  costRates?: CostRates;
}

export class Tracer {
  readonly #exporters: TraceExporter[];
  readonly #clock: () => number;
  readonly #costRates: CostRates;
  readonly #pending = new Set<Promise<void>>();
  /** Summaries of every finished trace, for session stats (`/stats`). */
  readonly summaries: TraceSummary[] = [];

  constructor({ exporters = [], clock = Date.now, costRates = { inputPerMTok: 0, outputPerMTok: 0 } }: TracerOptions = {}) {
    this.#exporters = exporters;
    this.#clock = clock;
    this.#costRates = costRates;
  }

  /** Runs `fn` as the root span of a new trace, exports the trace and returns it with the result. */
  async trace<T>(name: string, attributes: Attributes, fn: (root: ActiveSpan) => Promise<T>): Promise<{ result: T; trace: TraceRecord }> {
    const state: TraceState = { traceId: newId(16), clock: this.#clock, spans: [] };
    const outcome = await runSpan(state, undefined, name, attributes, fn, {});
    const trace: TraceRecord = {
      traceId: state.traceId,
      name,
      durationMs: outcome.span.durationMs,
      spans: [outcome.span, ...state.spans],
      summary: this.#summarize(state.traceId, name, outcome.span, state.spans),
    };
    this.summaries.push(trace.summary);
    this.#export(trace);
    if (outcome.failed) throw outcome.error;
    return { result: outcome.result as T, trace };
  }

  /** Waits for in-flight exports (call before exiting). */
  async flush(): Promise<void> {
    await Promise.all([...this.#pending]);
  }

  #summarize(traceId: string, name: string, root: SpanRecord, spans: SpanRecord[]): TraceSummary {
    const chats = spans.filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
    const sum = (key: string) => chats.reduce((total, s) => total + (typeof s.attributes[key] === "number" ? (s.attributes[key] as number) : 0), 0);
    const usage = { inputTokens: sum("gen_ai.usage.input_tokens"), outputTokens: sum("gen_ai.usage.output_tokens") };
    const route = root.attributes["app.route"];
    return {
      traceId,
      name,
      durationMs: root.durationMs,
      route: typeof route === "string" ? route : undefined,
      llmCalls: chats.length,
      ...usage,
      usageReported: chats.every((s) => typeof s.attributes["gen_ai.usage.input_tokens"] === "number"),
      costUsd: estimateCost(usage, this.#costRates),
    };
  }

  #export(trace: TraceRecord): void {
    for (const exporter of this.#exporters) {
      const done = Promise.resolve()
        .then(() => exporter.export(trace))
        .catch((error: unknown) => console.warn(`[tracing] export failed: ${error instanceof Error ? error.message : error}`))
        .finally(() => this.#pending.delete(done));
      this.#pending.add(done);
    }
  }
}
