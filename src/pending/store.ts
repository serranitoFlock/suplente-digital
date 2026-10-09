import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PendingReason = "unknown" | "escalated" | "unsupported_task";

export interface PendingEntry {
  id: string;
  createdAt: string;
  question: string;
  topic: string;
  reason: PendingReason;
  /** Draft prepared for a sensitive request. */
  draft?: string;
  /** Human backup decision for escalations. */
  decision?: "approved" | "rejected";
  note?: string;
}

export type NewPendingEntry = Omit<PendingEntry, "id" | "createdAt">;

/** Append-only JSON log of questions the bot could not resolve on its own. */
export class PendingStore {
  /** Serializes appends: concurrent background jobs would otherwise overwrite each other's read-modify-write. */
  #writes: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async list(): Promise<PendingEntry[]> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as PendingEntry[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  append(entry: NewPendingEntry): Promise<PendingEntry> {
    const write = this.#writes.then(() => this.#append(entry));
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async #append(entry: NewPendingEntry): Promise<PendingEntry> {
    const saved: PendingEntry = { id: randomUUID(), createdAt: new Date().toISOString(), ...entry };
    const entries = await this.list();
    entries.push(saved);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(entries, null, 2));
    return saved;
  }
}
