import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildScriptRegistry, loadScriptRegistry } from "../src/tools/scripts.js";

const root = process.cwd();
const FIXTURES = "tests/fixtures/scripts";

/** A valid entry; tests override one field at a time. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "echo",
  description: "Repite los argumentos.",
  command: `${FIXTURES}/echo-args.sh`,
  argv: ["--days", "{days}"],
  params: { days: { type: "int", min: 1, max: 30, default: 7 } },
  readOnly: true,
  timeoutMs: 2_000,
  ...overrides,
});

const build = async (...entries: unknown[]) => {
  const warnings: string[] = [];
  const registry = await buildScriptRegistry({ scripts: entries }, root, { warn: (message) => warnings.push(message) });
  return { registry, warnings };
};

describe("script registry", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scripts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads the committed example registry (demo script, guard-clean)", async () => {
    const warnings: string[] = [];
    const registry = await loadScriptRegistry(join(root, "config/scripts.example.json"), root, { warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
    expect(registry.ids()).toEqual(["failed-jobs"]);
    expect(registry.get("failed-jobs")?.commandPath).toBe(join(root, "scripts/demo/failed-jobs.sh"));
  });

  it("treats an absent registry file as no scripts and an unreadable one as an error", async () => {
    expect((await loadScriptRegistry(join(dir, "missing.json"), root)).size).toBe(0);
    await writeFile(join(dir, "bad.json"), "{ nope");
    await expect(loadScriptRegistry(join(dir, "bad.json"), root)).rejects.toThrow(/not valid JSON/);
    await writeFile(join(dir, "shape.json"), JSON.stringify({ scripts: "nope" }));
    await expect(loadScriptRegistry(join(dir, "shape.json"), root)).rejects.toThrow(/invalid/);
  });

  it.each([
    ["readOnly: false", { readOnly: false }],
    ["readOnly missing", { readOnly: undefined }],
    ["readOnly as a string", { readOnly: "true" }],
  ])("never registers an entry with %s", async (_, overrides) => {
    const { registry, warnings } = await build(entry(overrides));
    expect(registry.size).toBe(0);
    expect(warnings.join("\n")).toMatch(/"echo".*readOnly/s);
  });

  it("never registers a script the static guard flags, naming the id and the reason", async () => {
    const write = entry({ id: "retry-job", command: `${FIXTURES}/retry-job.sh`, argv: ["{job}"], params: { job: { type: "int", min: 1, max: 999999 } } });
    const { registry, warnings } = await build(write, entry());
    expect(registry.ids()).toEqual(["echo"]);
    expect(registry.rejected).toMatchObject([{ id: "retry-job" }]);
    expect(warnings.join("\n")).toMatch(/"retry-job".*http-write/s);
  });

  it.each([
    ["an invalid id", { id: "Bad Id" }],
    ["an unknown placeholder", { argv: ["{nope}"] }],
    ["a string param without pattern", { argv: ["{q}"], params: { q: { type: "string", maxLength: 10 } } }],
    ["an invalid regex pattern", { argv: ["{q}"], params: { q: { type: "string", pattern: "(", maxLength: 10 } } }],
    ["a default outside the bounds", { params: { days: { type: "int", min: 1, max: 30, default: 99 } } }],
    ["a timeout above the limit", { timeoutMs: 10 * 60_000 }],
    ["an absolute command", { command: "/bin/sh" }],
    ["a command outside the repo", { command: "../outside.sh" }],
    ["a missing command file", { command: `${FIXTURES}/missing.sh` }],
    ["an inline shell", { command: "sh", argv: ["-c", "echo {days}"] }],
    ["an interpreter with inline code", { command: "node", argv: ["-e", "console.log({days})"] }],
    ["a cwd outside the repo", { cwd: "../" }],
    ["an invalid env name", { env: ["lower-case"] }],
  ])("skips an entry with %s", async (_, overrides) => {
    const { registry, warnings } = await build(entry(overrides));
    expect(registry.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"echo"|entry #1/);
  });

  it("keeps the first of two entries with the same id", async () => {
    const { registry, warnings } = await build(entry(), entry({ description: "Otra." }));
    expect(registry.get("echo")?.description).toBe("Repite los argumentos.");
    expect(warnings.join("\n")).toMatch(/duplicate/);
  });

  describe("argument validation", () => {
    const strings = entry({
      argv: ["{days}", "{project}", "--branch={branch}"],
      params: {
        days: { type: "int", min: 1, max: 30, default: 7 },
        project: { type: "enum", values: ["todos", "acme-ui-kit"], default: "todos" },
        branch: { type: "string", pattern: "[a-z0-9/._-]+", maxLength: 40 },
      },
    });

    it("applies defaults and accepts numeric strings for int params", async () => {
      const { registry } = await build(strings);
      expect(registry.resolve({ script: "echo", args: { days: "3", branch: "main" } })).toEqual({
        script: "echo",
        args: { days: 3, project: "todos", branch: "main" },
      });
    });

    it.each([
      ["an unknown script id", { script: "nope", args: { branch: "main" } }],
      ["an unknown argument", { script: "echo", args: { branch: "main", extra: 1 } }],
      ["a missing required argument", { script: "echo", args: {} }],
      ["an int out of range", { script: "echo", args: { days: 31, branch: "main" } }],
      ["a non-integer", { script: "echo", args: { days: "7; touch X", branch: "main" } }],
      ["an enum value not declared", { script: "echo", args: { project: "acme-shell", branch: "main" } }],
      ["a string that does not fully match its pattern", { script: "echo", args: { branch: "main; touch X" } }],
      ["a string that looks like an option", { script: "echo", args: { branch: "--force" } }],
      ["a string over its max length", { script: "echo", args: { branch: "a".repeat(41) } }],
    ])("rejects %s", async (_, call) => {
      const { registry } = await build(strings);
      expect(registry.resolve(call)).toBeNull();
    });

    it("builds argv from literals and validated values, never through a shell", async () => {
      const { registry } = await build(strings);
      const script = registry.get("echo")!;
      expect(registry.argv(script, { days: 3, project: "todos", branch: "main" })).toEqual(["3", "todos", "--branch=main"]);
    });
  });

  it("describes each registered script for the model (id, description, params)", async () => {
    const { registry } = await build(entry());
    const [line] = registry.describe();
    expect(line).toContain("echo");
    expect(line).toContain("Repite los argumentos.");
    expect(line).toMatch(/days.*1.*30.*7/);
  });
});
