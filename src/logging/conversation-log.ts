import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Daily conversation log: one JSON line per completed request (and per approval decision) in
 * `<LOG_DIR>/YYYY-MM-DD.jsonl` (local date). Unlike traces (metadata only), these lines hold the
 * question and the full answer, so they stay local and gitignored (see docs/security.md).
 */

export type LogOutcome = "answered" | "no_se" | "clarify" | "refused" | "approval_pending" | "approved" | "rejected" | "failed";

export interface LoggedToolCall {
  name: string;
  args: Record<string, unknown>;
  readOnly: boolean;
  /** True when the data came from an earlier turn (no new tool call). */
  fromMemory?: boolean;
  /** Short summary of the result (item count + truncated JSON), not the full payload. */
  result: string;
}

export interface ConversationLogEntry {
  timestamp: string;
  /** `request`: a request finished (or paused for approval); `decision`: the human backup decided. */
  event: "request" | "decision";
  requestId: number;
  requester?: string;
  question: string;
  route?: string;
  outcome: LogOutcome;
  /** Final answer as produced by the graph, WITH `[n]` markers and the "Fuentes:" block. */
  answer?: string;
  /** Draft shown to the human backup (approval requests only). */
  draft?: string;
  /** Cited sources as "file › heading". */
  citedSources: string[];
  toolCalls: LoggedToolCall[];
  latencyMs: number;
  tokens?: { input: number; output: number; reported: boolean };
  /** Links the line to its trace in `data/traces.jsonl`. */
  traceId?: string;
  securityEvent?: "refusal";
  /** Human backup note on a decision. */
  note?: string;
  /** Technical error detail for failed requests. */
  error?: string;
}

export type NewLogEntry = Omit<ConversationLogEntry, "timestamp">;

export interface ConversationLogSink {
  append(entry: NewLogEntry): Promise<void>;
}

/** `YYYY-MM-DD` in local time (the file a person would look for "today"). */
export function localDateStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const MAX_RESULT_CHARS = 300;

/** "3 elementos: [{...}]…" — enough to audit what the bot saw without copying whole payloads. */
export function summarizeToolResult(result: unknown): string {
  const json = typeof result === "string" ? result : JSON.stringify(result);
  const trimmed = json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS - 1)}…` : json;
  return Array.isArray(result) ? `${result.length} ${result.length === 1 ? "elemento" : "elementos"}: ${trimmed}` : trimmed;
}

export class DailyJsonlLog implements ConversationLogSink {
  /** Serializes writes so concurrent jobs never interleave or lose lines (same pattern as PendingStore). */
  #writes: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  pathFor(date: Date): string {
    return join(this.dir, `${localDateStamp(date)}.jsonl`);
  }

  todayPath(): string {
    return this.pathFor(this.clock());
  }

  /** Lines in today's file (0 when it does not exist yet). */
  async countToday(): Promise<number> {
    try {
      return (await readFile(this.todayPath(), "utf8")).split("\n").filter((line) => line.trim()).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  append(entry: NewLogEntry): Promise<void> {
    const write = this.#writes.then(() => this.#append(entry));
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async #append(entry: NewLogEntry): Promise<void> {
    const now = this.clock();
    const line: ConversationLogEntry = { timestamp: now.toISOString(), ...entry };
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.pathFor(now), `${JSON.stringify(line)}\n`);
  }
}
