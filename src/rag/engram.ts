import { z } from "zod";
import { containsSecret } from "../security/guards.js";
import type { SourceDoc } from "./ingest.js";

/**
 * Engram (the owner's persistent agent memory) as a second knowledge source.
 * Input is the JSON written by `engram export` (format version 0.2.0: `observations`, `relations`, ...).
 * Only durable project knowledge is kept; see docs/security.md ("Engram as a knowledge source").
 */

/** Observation types that hold reusable knowledge. Session summaries, passive captures and manual notes are left out. */
export const DEFAULT_ENGRAM_TYPES = ["decision", "architecture", "pattern", "config", "discovery", "bugfix", "learning"] as const;

const observationSchema = z.object({
  id: z.number(),
  sync_id: z.string().optional(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
  project: z.string().nullable().default(""),
  scope: z.string().nullable().default(""),
  created_at: z.string(),
  updated_at: z.string(),
  topic_key: z.string().nullable().optional(),
  deleted_at: z.string().nullable().optional(),
});

const relationSchema = z.object({
  source_id: z.string(),
  target_id: z.string(),
  relation: z.string(),
  judgment_status: z.string().nullable().optional(),
});

const exportSchema = z.object({
  observations: z.array(observationSchema),
  relations: z.array(relationSchema).nullable().optional(),
});

export type EngramObservation = z.input<typeof observationSchema>;
export type EngramRelation = z.input<typeof relationSchema>;

export interface EngramExport {
  observations: EngramObservation[];
  relations: EngramRelation[];
}

export function parseEngramExport(raw: unknown, origin = "Engram export"): EngramExport {
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${origin} is not a valid Engram export (${issue?.path.join(".") || "root"}: ${issue?.message}).`);
  }
  return { observations: parsed.data.observations, relations: parsed.data.relations ?? [] };
}

export type DropReason = "deleted" | "scope" | "type" | "project" | "superseded" | "older_topic_version" | "secret";

export interface FilterOptions {
  /** Observation types to keep (default `DEFAULT_ENGRAM_TYPES`). */
  types?: readonly string[];
  /** When given, only observations of these projects are kept (defense in depth for real exports). */
  projects?: readonly string[];
}

export interface FilterResult {
  kept: EngramObservation[];
  dropped: Record<DropReason, number>;
}

const timestamp = (value: string | undefined) => {
  const ms = Date.parse(`${(value ?? "").trim().replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Newer first: updated_at, then created_at, then id. */
const isNewer = (a: EngramObservation, b: EngramObservation) =>
  timestamp(a.updated_at) - timestamp(b.updated_at) || timestamp(a.created_at) - timestamp(b.created_at) || a.id - b.id;

/**
 * Keeps durable project knowledge, in this order: not soft-deleted, `scope=project`, allowlisted type
 * and project, not the target of a judged `supersedes` relation, latest version per project + topic_key,
 * no token formats the output guard would redact. Order of `kept` follows the export.
 */
export function filterObservations(data: EngramExport, options: FilterOptions = {}): FilterResult {
  const types = new Set(options.types ?? DEFAULT_ENGRAM_TYPES);
  const projects = options.projects ? new Set(options.projects) : undefined;
  const dropped: Record<DropReason, number> = { deleted: 0, scope: 0, type: 0, project: 0, superseded: 0, older_topic_version: 0, secret: 0 };
  const superseded = new Set(
    data.relations.filter((r) => r.relation === "supersedes" && (r.judgment_status ?? "judged") === "judged").map((r) => r.target_id),
  );

  const eligible = data.observations.filter((o) => {
    const reason: DropReason | undefined = o.deleted_at
      ? "deleted"
      : o.scope !== "project"
        ? "scope"
        : !types.has(o.type)
          ? "type"
          : projects && !projects.has(o.project ?? "")
            ? "project"
            : o.sync_id && superseded.has(o.sync_id)
              ? "superseded"
              : undefined;
    if (reason) dropped[reason]++;
    return !reason;
  });

  const latest = new Map<string, EngramObservation>();
  for (const o of eligible) {
    if (!o.topic_key) continue;
    const key = `${o.project}\u0000${o.topic_key}`;
    const current = latest.get(key);
    if (!current || isNewer(o, current) > 0) latest.set(key, o);
  }

  const kept = eligible.filter((o) => {
    if (o.topic_key && latest.get(`${o.project}\u0000${o.topic_key}`) !== o) {
      dropped.older_topic_version++;
      return false;
    }
    if (containsSecret(`${o.title}\n${o.content}`)) {
      dropped.secret++;
      return false;
    }
    return true;
  });
  return { kept, dropped };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Source label used in citations and logs: `engram:#<id> › <project> › <title>`. */
export function engramSourceLabel(o: EngramObservation): string {
  return `engram:#${o.id} › ${oneLine(o.project ?? "")} › ${oneLine(o.title)}`;
}

/**
 * One doc per note: the content goes through the existing markdown chunking, and the note title is
 * the contextual header of every chunk. The title is not a heading, so citations read
 * `engram:#<id> › <project> › <title>` without repeating it.
 */
export function engramSourceDocs(observations: EngramObservation[]): SourceDoc[] {
  return observations.map((o) => ({ source: engramSourceLabel(o), title: oneLine(o.title), markdown: `${o.content.trim()}\n` }));
}
