import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEngramSourcesConfig, parseEngramSourcesConfig, resolveFlag } from "../src/rag/engram-config.js";
import { buildExportCommands, exportProjects } from "../src/rag/engram-export.js";
import { loadEngramDocs } from "../src/rag/ingest.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "suplente-engram-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseEngramSourcesConfig", () => {
  it("accepts an allowlist of project names and defaults the type allowlist", () => {
    const parsed = parseEngramSourcesConfig({ projects: ["acme-shell", "acme-ui-kit"] });
    expect(parsed.projects).toEqual(["acme-shell", "acme-ui-kit"]);
    expect(parsed.types).toContain("decision");
    expect(parsed.types).not.toContain("session_summary");
  });

  it("accepts a custom type allowlist", () => {
    expect(parseEngramSourcesConfig({ projects: ["acme-shell"], types: ["bugfix"] }).types).toEqual(["bugfix"]);
  });

  it.each([
    [{}, /projects/],
    [{ projects: [] }, /projects/],
    [{ projects: ["../etc"] }, /invalid project name/],
    [{ projects: ["--all"] }, /invalid project name/],
    [{ projects: ["a b"] }, /invalid project name/],
    [{ projects: ["acme", "acme"] }, /duplicate/],
    [{ projects: ["acme"], types: ["session_summary"] }, /session_summary/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseEngramSourcesConfig(raw)).toThrow(message);
  });
});

describe("loadEngramSourcesConfig", () => {
  it("fails clearly when the local config is missing, pointing to the example", async () => {
    await expect(loadEngramSourcesConfig(join(dir, "engram-sources.local.json"))).rejects.toThrow(/engram-sources\.example\.json/);
  });

  it("loads and validates the file", async () => {
    const path = join(dir, "engram-sources.local.json");
    await writeFile(path, JSON.stringify({ projects: ["acme-shell"] }));
    expect((await loadEngramSourcesConfig(path)).projects).toEqual(["acme-shell"]);
  });
});

describe("resolveFlag", () => {
  it("parses booleans with a default", () => {
    expect(resolveFlag("ENGRAM_REAL", undefined, true)).toBe(true);
    expect(resolveFlag("ENGRAM_REAL", "false", true)).toBe(false);
    expect(resolveFlag("ENGRAM_REAL", " 0 ", true)).toBe(false);
    expect(resolveFlag("ENGRAM_SAMPLE", "sí", false)).toBe(true);
    expect(() => resolveFlag("ENGRAM_REAL", "maybe", true)).toThrow(/ENGRAM_REAL/);
  });
});

describe("engram export", () => {
  it("builds one `engram export <file> --project <name>` argv per project (no shell)", () => {
    expect(buildExportCommands(["acme-shell", "acme-ui-kit"], "/repo/data/engram")).toEqual([
      { project: "acme-shell", outFile: "/repo/data/engram/acme-shell.json", command: "engram", args: ["export", "/repo/data/engram/acme-shell.json", "--project", "acme-shell"] },
      { project: "acme-ui-kit", outFile: "/repo/data/engram/acme-ui-kit.json", command: "engram", args: ["export", "/repo/data/engram/acme-ui-kit.json", "--project", "acme-ui-kit"] },
    ]);
  });

  it("runs each command through the injected runner, creating the output dir first", async () => {
    const calls: string[][] = [];
    const outDir = join(dir, "data", "engram");
    const results = await exportProjects(["acme-shell"], outDir, async (command, args) => {
      calls.push([command, ...args]);
      await writeFile(args[1]!, JSON.stringify({ observations: [{ id: 1, type: "decision", title: "t", content: "c", project: "acme-shell", scope: "project", created_at: "x", updated_at: "x" }] }));
    });
    expect(calls).toEqual([["engram", "export", join(outDir, "acme-shell.json"), "--project", "acme-shell"]]);
    expect(results).toEqual([{ project: "acme-shell", outFile: join(outDir, "acme-shell.json"), observations: 1 }]);
  });

  it("reports a failing export with the project name", async () => {
    await expect(
      exportProjects(["acme-shell"], dir, async () => {
        throw new Error("engram: command not found");
      }),
    ).rejects.toThrow(/acme-shell.*command not found/);
  });
});

describe("loadEngramDocs", () => {
  const note = (id: number, project: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: "decision",
    title: `Nota ${id}`,
    content: "**What**: algo.",
    project,
    scope: "project",
    created_at: "2026-01-01 10:00:00",
    updated_at: "2026-01-01 10:00:00",
    ...extra,
  });

  it("includes the sample and the real exports of allowlisted projects only", async () => {
    const samplePath = join(dir, "engram-sample.json");
    const exportDir = join(dir, "engram");
    const configPath = join(dir, "engram-sources.local.json");
    await mkdir(exportDir);
    await writeFile(samplePath, JSON.stringify({ observations: [note(1, "acme-shell"), note(2, "acme-shell", { scope: "personal" })] }));
    await writeFile(configPath, JSON.stringify({ projects: ["acme-real"] }));
    await writeFile(join(exportDir, "acme-real.json"), JSON.stringify({ observations: [note(10, "acme-real"), note(11, "other-team")] }));
    await writeFile(join(exportDir, "not-allowlisted.json"), JSON.stringify({ observations: [note(20, "not-allowlisted")] }));

    const { docs, reports } = await loadEngramDocs({ samplePath, includeSample: true, includeReal: true, configPath, exportDir });
    expect(docs.map((d) => [d.source, d.origin])).toEqual([
      ["engram:#1 › acme-shell › Nota 1", "engram-sample"],
      ["engram:#10 › acme-real › Nota 10", "engram-real"],
    ]);
    expect(reports.map((r) => [r.name, r.raw, r.kept])).toEqual([
      ["sample", 2, 1],
      ["acme-real", 2, 1],
    ]);
    expect(reports.find((r) => r.name === "acme-real")?.dropped.project).toBe(1);
  });

  it("skips real exports when disabled or when the local config is missing", async () => {
    const samplePath = join(dir, "engram-sample.json");
    await writeFile(samplePath, JSON.stringify({ observations: [note(1, "acme-shell")] }));
    const disabled = await loadEngramDocs({ samplePath, includeSample: false, includeReal: false, configPath: join(dir, "none.json"), exportDir: dir });
    expect(disabled.docs).toEqual([]);
    const missing = await loadEngramDocs({ samplePath, includeSample: true, includeReal: true, configPath: join(dir, "none.json"), exportDir: dir });
    expect(missing.docs.map((d) => d.origin)).toEqual(["engram-sample"]);
    expect(missing.notes.join(" ")).toMatch(/engram-sources\.example\.json/);
  });
});
