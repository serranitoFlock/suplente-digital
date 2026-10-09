import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENGRAM_TYPES,
  engramSourceDocs,
  engramSourceLabel,
  filterObservations,
  parseEngramExport,
  type EngramExport,
  type EngramObservation,
} from "../src/rag/engram.js";
import { chunkMarkdown } from "../src/rag/chunk.js";
import { sourceLabel } from "../src/graph/citations.js";
import { contextualPassage } from "../src/rag/ingest.js";
import { containsSecret } from "../src/security/guards.js";

const sample = async () => parseEngramExport(JSON.parse(await readFile(new URL("../knowledge/engram-sample.json", import.meta.url), "utf8")));

const obs = (overrides: Partial<EngramObservation> & { id: number }): EngramObservation => ({
  sync_id: `obs-${overrides.id}`,
  type: "decision",
  title: `Nota ${overrides.id}`,
  content: "**What**: algo útil.",
  project: "acme-shell",
  scope: "project",
  created_at: "2026-01-01 10:00:00",
  updated_at: "2026-01-01 10:00:00",
  topic_key: "",
  deleted_at: null,
  ...overrides,
});

const exportOf = (observations: EngramObservation[], relations: EngramExport["relations"] = []): EngramExport => ({ observations, relations });

describe("parseEngramExport", () => {
  it("parses the committed sample in the real export format", async () => {
    const data = await sample();
    expect(data.observations).toHaveLength(14);
    expect(data.relations).toHaveLength(2);
    expect(data.observations[0]).toMatchObject({ id: 9101, type: "decision", project: "acme-shell", scope: "project" });
  });

  it("accepts a missing relations list and null prompts", () => {
    const data = parseEngramExport({ version: "0.2.0", observations: [obs({ id: 1 })], prompts: null });
    expect(data.relations).toEqual([]);
  });

  it("rejects something that is not an Engram export", () => {
    expect(() => parseEngramExport({ notes: [] }, "x.json")).toThrow(/x\.json.*not a valid Engram export/);
    expect(() => parseEngramExport({ observations: [{ id: "a" }] })).toThrow(/not a valid Engram export/);
  });
});

describe("filterObservations", () => {
  it("keeps only allowlisted types (session summaries and passive captures are dropped)", () => {
    const result = filterObservations(
      exportOf([obs({ id: 1, type: "bugfix" }), obs({ id: 2, type: "session_summary" }), obs({ id: 3, type: "passive" }), obs({ id: 4, type: "manual" })]),
    );
    expect(result.kept.map((o) => o.id)).toEqual([1]);
    expect(result.dropped.type).toBe(3);
  });

  it("uses a custom type allowlist when given", () => {
    const result = filterObservations(exportOf([obs({ id: 1, type: "manual" }), obs({ id: 2, type: "decision" })]), { types: ["manual"] });
    expect(result.kept.map((o) => o.id)).toEqual([1]);
  });

  it("keeps only project scope (never personal or global)", () => {
    const result = filterObservations(exportOf([obs({ id: 1 }), obs({ id: 2, scope: "personal" }), obs({ id: 3, scope: "global" })]));
    expect(result.kept.map((o) => o.id)).toEqual([1]);
    expect(result.dropped.scope).toBe(2);
  });

  it("skips soft-deleted observations", () => {
    const result = filterObservations(exportOf([obs({ id: 1 }), obs({ id: 2, deleted_at: "2026-02-01 00:00:00" })]));
    expect(result.kept.map((o) => o.id)).toEqual([1]);
    expect(result.dropped.deleted).toBe(1);
  });

  it("keeps only allowlisted projects when a project list is given", () => {
    const result = filterObservations(exportOf([obs({ id: 1 }), obs({ id: 2, project: "other-team" })]), { projects: ["acme-shell"] });
    expect(result.kept.map((o) => o.id)).toEqual([1]);
    expect(result.dropped.project).toBe(1);
  });

  it("keeps only the latest version per project + topic_key (by updated_at, then created_at, then id)", () => {
    const result = filterObservations(
      exportOf([
        obs({ id: 1, topic_key: "shell/timeout", updated_at: "2026-03-01 10:00:00" }),
        obs({ id: 2, topic_key: "shell/timeout", updated_at: "2026-06-01 10:00:00" }),
        obs({ id: 3, topic_key: "shell/timeout", updated_at: "2026-04-01 10:00:00" }),
        obs({ id: 4, topic_key: "shell/timeout", project: "acme-ui-kit", updated_at: "2026-01-01 10:00:00" }),
        obs({ id: 5, topic_key: "" }),
        obs({ id: 6, topic_key: "" }),
      ]),
    );
    expect(result.kept.map((o) => o.id)).toEqual([2, 4, 5, 6]);
    expect(result.dropped.older_topic_version).toBe(2);
  });

  it("does not let a deleted newer version resurrect nor hide: the newest live version wins", () => {
    const result = filterObservations(
      exportOf([obs({ id: 1, topic_key: "k", updated_at: "2026-01-01 10:00:00" }), obs({ id: 2, topic_key: "k", updated_at: "2026-02-01 10:00:00", deleted_at: "2026-02-02 00:00:00" })]),
    );
    expect(result.kept.map((o) => o.id)).toEqual([1]);
  });

  it("drops the target of a judged `supersedes` relation", () => {
    const relations = [
      { source_id: "obs-2", target_id: "obs-1", relation: "supersedes", judgment_status: "judged" },
      { source_id: "obs-3", target_id: "obs-2", relation: "related", judgment_status: "judged" },
      { source_id: "obs-4", target_id: "obs-3", relation: "supersedes", judgment_status: "pending" },
    ];
    const result = filterObservations(exportOf([obs({ id: 1 }), obs({ id: 2 }), obs({ id: 3 }), obs({ id: 4 })], relations));
    expect(result.kept.map((o) => o.id)).toEqual([2, 3, 4]);
    expect(result.dropped.superseded).toBe(1);
  });

  it("drops observations that contain a token format the output guard redacts", () => {
    const result = filterObservations(exportOf([obs({ id: 1 }), obs({ id: 2, content: "token glpat-AbCdEfGhIjKlMnOpQrStUv" }), obs({ id: 3, title: "npm_abcdefghijklmnopqrstuvwxyz0123456789" })]));
    expect(result.kept.map((o) => o.id)).toEqual([1]);
    expect(result.dropped.secret).toBe(2);
  });

  it("reduces the committed sample to the 7 useful project notes", async () => {
    const result = filterObservations(await sample());
    expect(result.kept.map((o) => o.id)).toEqual([9102, 9103, 9104, 9105, 9106, 9107, 9108]);
    expect(result.dropped).toEqual({ deleted: 1, scope: 1, type: 2, project: 0, superseded: 1, older_topic_version: 1, secret: 1 });
  });

  it("defaults to the documented type allowlist", () => {
    expect([...DEFAULT_ENGRAM_TYPES].sort()).toEqual(["architecture", "bugfix", "config", "decision", "discovery", "learning", "pattern"]);
  });
});

describe("containsSecret", () => {
  it("detects the token formats of the output guard and is stable across calls", () => {
    expect(containsSecret("usá sk-ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(true);
    expect(containsSecret("usá sk-ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(true);
    expect(containsSecret("nada secreto acá")).toBe(false);
  });
});

describe("engram source labels and documents", () => {
  it("labels a note as engram:#<id> › <project> › <title>", () => {
    expect(engramSourceLabel(obs({ id: 42, project: "acme-ui-kit", title: "  Estilos\nduplicados  " }))).toBe("engram:#42 › acme-ui-kit › Estilos duplicados");
  });

  it("turns each note into a doc whose chunks carry the label, with the title as contextual header (not a heading)", () => {
    const [doc] = engramSourceDocs([obs({ id: 7, title: "Feature flags", content: "**What**: se leen de `flags.json`." })]);
    expect(doc).toMatchObject({ source: "engram:#7 › acme-shell › Feature flags", title: "Feature flags" });
    const chunks = chunkMarkdown(doc!.source, doc!.markdown);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ source: "engram:#7 › acme-shell › Feature flags", heading: "" });
    expect(chunks[0]!.text).toContain("flags.json");
    expect(contextualPassage(chunks[0]!, doc!.title!)).toMatch(/^Documento: Feature flags\n\*\*What\*\*/);
    expect(sourceLabel(chunks[0]!)).toBe("engram:#7 › acme-shell › Feature flags");
    expect(sourceLabel({ source: "cdn-manifiesto.md", heading: "Pasos" })).toBe("cdn-manifiesto.md › Pasos");
  });

  it("splits a long note with the existing chunk size logic", () => {
    const long = Array.from({ length: 6 }, (_, i) => `Párrafo ${i} ${"x".repeat(300)}`).join("\n\n");
    const [doc] = engramSourceDocs([obs({ id: 8, content: long })]);
    expect(chunkMarkdown(doc!.source, doc!.markdown).length).toBeGreaterThan(1);
  });
});

describe("inBatches (passage embedding batches)", () => {
  it("splits into consecutive batches of at most `size`", async () => {
    const { inBatches } = await import("../src/rag/embeddings.js");
    expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inBatches([], 16)).toEqual([]);
    expect(() => inBatches([1], 0)).toThrow();
  });
});
