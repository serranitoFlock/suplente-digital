import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import { OUTPUT_TRUNCATED_MARKER, ScriptToolProvider, runScript, withScripts } from "../src/tools/script-provider.js";
import { buildScriptRegistry, loadScriptRegistry, ScriptRegistry } from "../src/tools/scripts.js";
import { ToolCallError, ToolNotAllowedError, type ToolProvider } from "../src/tools/types.js";

const root = process.cwd();
const FIXTURES = "tests/fixtures/scripts";

const fixture = (id: string, file: string, overrides: Record<string, unknown> = {}) => ({
  id,
  description: `Fixture ${id}.`,
  command: `${FIXTURES}/${file}`,
  argv: [],
  params: {},
  readOnly: true,
  timeoutMs: 5_000,
  ...overrides,
});

const registryOf = (...entries: unknown[]) => buildScriptRegistry({ scripts: entries }, root, { warn: () => undefined });

describe("script runner", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "script-run-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("runs the demo script with validated arguments", async () => {
    const registry = await loadScriptRegistry(join(root, "config/scripts.example.json"), root);
    const provider = new ScriptToolProvider(new MockToolProvider(), registry);
    const jobs = JSON.parse(await provider.call({ tool: "run_script", args: { script: "failed-jobs", args: { days: 3 } } }));
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job: { daysAgo: number }) => job.daysAgo <= 3)).toBe(true);
    const one = JSON.parse(await provider.call({ tool: "run_script", args: { script: "failed-jobs", args: { days: 30, project: "acme-shell" } } }));
    expect(one.map((job: { project: string; id: number }) => `${job.project}#${job.id}`)).toEqual(["acme-shell#4540", "acme-shell#4488"]);
  });

  it("sends every other tool to the wrapped provider", async () => {
    const provider = new ScriptToolProvider(new MockToolProvider(), await registryOf(fixture("echo", "echo-args.sh")));
    expect(JSON.parse(await provider.call({ tool: "get_ticket", args: { key: "DEMO-101" } })).key).toBe("DEMO-101");
    expect(provider.name).toBe("mock");
    expect(provider.scripts.size).toBe(1);
  });

  it("is not added at all when no script is registered", async () => {
    const base = new MockToolProvider();
    expect(withScripts(base, new ScriptRegistry([]))).toBe(base);
    expect((base as ToolProvider).scripts).toBeUndefined();
  });

  it("never executes an unknown script or invalid arguments", async () => {
    const execute = vi.fn(async () => "ran");
    const registry = await registryOf(fixture("echo", "echo-args.sh", { argv: ["{days}"], params: { days: { type: "int", min: 1, max: 30 } } }));
    const provider = new ScriptToolProvider(new MockToolProvider(), registry, { execute });
    await expect(provider.call({ tool: "run_script", args: { script: "rm-everything", args: {} } })).rejects.toThrow(ToolNotAllowedError);
    await expect(provider.call({ tool: "run_script", args: { script: "echo", args: { days: "7; touch X" } } })).rejects.toThrow(ToolNotAllowedError);
    await expect(provider.call({ tool: "run_script", args: { script: "echo", args: { days: 99 } } })).rejects.toThrow(ToolNotAllowedError);
    expect(execute).not.toHaveBeenCalled();
    expect(await provider.call({ tool: "run_script", args: { script: "echo", args: { days: 7 } } })).toBe("ran");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("passes parameter values as single arguments: no shell ever interprets them", async () => {
    const marker = join(dir, "pwned");
    const registry = await registryOf(
      fixture("echo", "echo-args.sh", { argv: ["{text}"], params: { text: { type: "string", pattern: "[^\\n]+", maxLength: 200 } } }),
    );
    const value = `7; touch ${marker} && echo $(id) \`id\` | cat > ${marker}`;
    const output = await runScript(registry.get("echo")!, registry.argv(registry.get("echo")!, { text: value }));
    expect(output.trim()).toBe(value);
    expect(existsSync(marker)).toBe(false);
  });

  it("kills a script that exceeds its timeout", async () => {
    const registry = await registryOf(fixture("slow", "slow.sh", { timeoutMs: 300 }));
    const started = Date.now();
    const error = await runScript(registry.get("slow")!, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("fails with a ToolCallError that never carries stderr", async () => {
    const registry = await registryOf(fixture("fail", "fail.sh"));
    const error = await runScript(registry.get("fail")!, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).kind).toBe("script_error");
    expect((error as ToolCallError).tool).toBe("run_script");
    expect(String((error as Error).message)).not.toMatch(/token|internal detail/);
  });

  it("caps the output and marks it as truncated", async () => {
    const registry = await registryOf(fixture("big", "big-output.sh"));
    const output = await runScript(registry.get("big")!, [], { maxOutputBytes: 1_000 });
    expect(output.endsWith(OUTPUT_TRUNCATED_MARKER)).toBe(true);
    expect(Buffer.byteLength(output.slice(0, -OUTPUT_TRUNCATED_MARKER.length))).toBeLessThanOrEqual(1_000);
    expect(output.startsWith("line 0 of")).toBe(true);
  });

  it("passes only the declared environment variables", async () => {
    vi.stubEnv("SUPLENTE_TEST_ALLOWED", "visible");
    vi.stubEnv("SUPLENTE_TEST_SECRET", "hidden");
    const registry = await registryOf(fixture("env", "print-env.sh", { env: ["SUPLENTE_TEST_ALLOWED"] }));
    const output = await runScript(registry.get("env")!, []);
    expect(output).toContain("allowed=visible");
    expect(output).toContain("secret=unset");
  });
});

describe("tool providers and run_script", () => {
  it("the mock provider never runs scripts itself", async () => {
    const error = await new MockToolProvider().call({ tool: "run_script", args: { script: "x", args: {} } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).kind).toBe("missing_tool");
  });
});
