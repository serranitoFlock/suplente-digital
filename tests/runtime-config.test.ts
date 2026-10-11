import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolSelectionPrompt } from "../src/graph/task.js";
import { SwitchableLlm, type Llm, type LlmSettings } from "../src/llm.js";
import { SETTINGS_SCHEMA, SettingsStore } from "../src/persistence/settings-store.js";
import { openDatabase } from "../src/persistence/sqlite.js";
import { ConfigValidationError, loadBaseline, RuntimeConfig, type RuntimeConfigOptions } from "../src/runtime-config.js";
import { AssistantService } from "../src/service/assistant-service.js";
import { MockToolProvider } from "../src/tools/mock-provider.js";
import { withReloadableScripts } from "../src/tools/script-provider.js";
import { ScriptRegistry } from "../src/tools/scripts.js";
import { answered, nextEvent } from "./helpers/controlled-runner.js";

const root = process.cwd();
const FIXTURES = "tests/fixtures/scripts";
const SECRET = "sk-ant-api03-super-secret-value";

const scriptEntry = (overrides: Record<string, unknown> = {}) => ({
  id: "echo",
  description: "Repite los argumentos.",
  command: `${FIXTURES}/echo-args.sh`,
  argv: ["--days", "{days}"],
  params: { days: { type: "int", min: 1, max: 30, default: 7 } },
  readOnly: true,
  timeoutMs: 2_000,
  ...overrides,
});

let dir: string;
let db: DatabaseSync;
let store: SettingsStore;
let built: LlmSettings[];

/** Fake model factory: every model answers with its own label, so tests can tell which one ran. */
const fakeCreateLlm = (settings: LlmSettings): Llm => {
  built.push(settings);
  return async () => `reply from ${settings.model}`;
};

async function make(env: Record<string, string | undefined> = { LLM_MODEL: "env-model" }, options: Partial<RuntimeConfigOptions> = {}) {
  const baseline = await loadBaseline({ env, mcpToolsPath: join(dir, "mcp-tools.json"), scriptsPath: join(dir, "scripts.json") });
  return RuntimeConfig.create({ store, baseline, scriptsRoot: root, createLlm: fakeCreateLlm, warn: () => undefined, ...options });
}

const issuesOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected a ConfigValidationError");
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runtime-config-"));
  db = openDatabase(join(dir, "assistant.db"), [SETTINGS_SCHEMA]);
  store = new SettingsStore(db, { secretKeys: ["llm.anthropicApiKey"] });
  built = [];
});

afterEach(async () => {
  if (db.isOpen) db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("effective configuration", () => {
  it("with an empty settings table resolves exactly what the environment resolves today", async () => {
    const rc = await make({ LLM_MODEL: "qwen3:8b", LLM_TEMPERATURE: "0.3", MEMORY_TURNS: "4", SHOW_CITATIONS: "true" });
    expect(rc.llmSettings()).toEqual({
      provider: "openai-compatible",
      model: "qwen3:8b",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "not-needed",
      temperature: 0.3,
      disableThinking: true,
    });
    const view = rc.view();
    expect(view.settings.llm.model).toMatchObject({ value: "qwen3:8b", source: "env", restartRequired: false });
    expect(view.settings.llm.baseUrl).toMatchObject({ value: "http://localhost:11434/v1", source: "default" });
    expect(view.settings.assistant.memoryTurns).toMatchObject({ value: 4, source: "env" });
    expect(view.settings.assistant.showCitations).toMatchObject({ value: true, source: "env" });
    expect(view.settings.mcp.serverCommand).toMatchObject({ value: null, source: "default", restartRequired: true });
    expect(view.settings.scripts.registry).toMatchObject({ value: { scripts: [] }, source: "default" });
    expect(view.llm.description).toBe("qwen3:8b @ http://localhost:11434/v1");
  });

  it("reads the MCP mapping and the script registry files as the env layer", async () => {
    const mapping = { tools: { get_ticket: { name: "jira_get_issue", args: { issue_key: { arg: "key" } } } } };
    await writeFile(join(dir, "mcp-tools.json"), JSON.stringify(mapping));
    await writeFile(join(dir, "scripts.json"), JSON.stringify({ scripts: [scriptEntry()] }));
    const rc = await make({ LLM_MODEL: "m", MCP_SERVER_COMMAND: "npx", MCP_SERVER_ARGS: "-y server", MCP_CALL_TIMEOUT_MS: "5000" });
    const { mcp, scripts } = rc.view().settings;
    expect(mcp.toolsMapping).toMatchObject({ value: mapping, source: "env" });
    expect(mcp.serverArgs).toMatchObject({ value: ["-y", "server"], source: "env" });
    expect(mcp.callTimeoutMs).toMatchObject({ value: 5000, source: "env" });
    expect(scripts.registry.source).toBe("env");
    expect(rc.registry().ids()).toEqual(["echo"]);
  });

  it("panel values win over the environment, and a reset (null) falls back to it", async () => {
    store.write({ "llm.model": "panel-model" });
    const rc = await make();
    expect(rc.llmSettings().model).toBe("panel-model");
    expect(rc.view().settings.llm.model).toMatchObject({ value: "panel-model", source: "panel", updatedAt: expect.any(String) });
    await rc.update({ llm: { model: null } });
    expect(rc.view().settings.llm.model).toMatchObject({ value: "env-model", source: "env" });
    expect(store.entries().has("llm.model")).toBe(false);
  });

  it("only the keys in a patch change", async () => {
    const rc = await make();
    await rc.update({ llm: { temperature: 0.1 } });
    await rc.update({ assistant: { memoryTurns: 2 } });
    expect(rc.view().settings.llm.temperature).toMatchObject({ value: 0.1, source: "panel" });
    expect(rc.view().settings.assistant.memoryTurns).toMatchObject({ value: 2, source: "panel" });
  });
});

describe("validation", () => {
  it("rejects a bad temperature and an unknown provider with paths, persisting nothing", async () => {
    const rc = await make();
    expect(await issuesOf(rc.update({ llm: { temperature: -1 } }))).toEqual([expect.objectContaining({ path: "llm.temperature" })]);
    expect(await issuesOf(rc.update({ llm: { provider: "gemini" } }))).toEqual([expect.objectContaining({ path: "llm.provider" })]);
    expect(await issuesOf(rc.update({ llm: { nope: 1 } }))).not.toHaveLength(0);
    expect(store.entries().size).toBe(0);
    expect(store.audit()).toEqual([]);
  });

  it("rejects switching to anthropic without a key (the existing resolver decides)", async () => {
    const rc = await make();
    const issues = await issuesOf(rc.update({ llm: { provider: "anthropic" } }));
    expect(issues).toEqual([expect.objectContaining({ path: "llm", message: expect.stringMatching(/ANTHROPIC_API_KEY/) })]);
    expect(store.entries().size).toBe(0);
  });

  it("refuses the secret in the general patch: it has its own write-only endpoint", async () => {
    const rc = await make();
    expect(await issuesOf(rc.update({ llm: { anthropicApiKey: SECRET } }))).not.toHaveLength(0);
    expect(store.entries().size).toBe(0);
  });

  it("rejects a registry with a readOnly:false entry or a guard hit, with the reasons, and keeps the old one", async () => {
    const rc = await make();
    const writeCapable = await issuesOf(rc.update({ scripts: { registry: { scripts: [scriptEntry({ readOnly: false })] } } }));
    expect(writeCapable).toEqual([{ path: "scripts.registry.echo", message: expect.stringMatching(/readOnly/) }]);
    const guardHit = scriptEntry({ id: "poster", command: "curl", argv: ["-X", "POST", "https://example.com"], params: {} });
    const guarded = await issuesOf(rc.update({ scripts: { registry: { scripts: [guardHit] } } }));
    expect(guarded).toEqual([{ path: "scripts.registry.poster", message: expect.stringMatching(/write guard/) }]);
    expect(await issuesOf(rc.update({ scripts: { registry: { nope: [] } } }))).toEqual([expect.objectContaining({ path: "scripts.registry" })]);
    expect(store.entries().size).toBe(0);
    expect(rc.registry().size).toBe(0);
  });

  it("validates the MCP mapping with the mapping file schema", async () => {
    const rc = await make();
    const issues = await issuesOf(rc.update({ mcp: { toolsMapping: { tools: { get_ticket: { name: "x", args: { k: { arg: "nope" } } } } } } }));
    expect(issues).toEqual([expect.objectContaining({ path: "mcp.toolsMapping", message: expect.stringMatching(/nope/) })]);
  });
});

describe("hot apply", () => {
  it("swaps the model for the next job after a model/temperature change", async () => {
    const llm = new SwitchableLlm(fakeCreateLlm({ provider: "openai-compatible", model: "env-model" } as LlmSettings));
    const rc = await make(undefined, { appliers: { llm: (settings) => llm.set(fakeCreateLlm(settings)) } });
    const service = new AssistantService({
      ask: async (question) => answered(await llm.call("system", question)),
      resume: async () => answered("-"),
    });

    service.submit("primera");
    expect((await nextEvent(service, "done")).answer).toBe("reply from env-model");

    const result = await rc.update({ llm: { model: "new-model", temperature: 0.1 } });
    expect(result.applied).toEqual(expect.arrayContaining(["llm.model", "llm.temperature"]));
    expect(result.restartRequired).toEqual([]);
    expect(built.at(-1)).toMatchObject({ model: "new-model", temperature: 0.1 });

    service.submit("segunda");
    expect((await nextEvent(service, "done")).answer).toBe("reply from new-model");
  });

  it("applies memory turns and citations to later jobs", async () => {
    const seen: unknown[] = [];
    const rc = await make(undefined, { appliers: { memoryTurns: (n) => seen.push(["turns", n]), showCitations: (b) => seen.push(["citations", b]) } });
    const result = await rc.update({ assistant: { memoryTurns: 0, showCitations: true } });
    expect(result.applied).toEqual(["assistant.memoryTurns", "assistant.showCitations"]);
    expect(seen).toEqual([
      ["turns", 0],
      ["citations", true],
    ]);
  });

  it("reloads the script registry: the selection prompt lists the new scripts", async () => {
    const provider = withReloadableScripts(new MockToolProvider(), new ScriptRegistry([]));
    const rc = await make(undefined, { appliers: { scripts: (registry) => provider.reload(registry) } });
    expect(toolSelectionPrompt(provider.scripts)).not.toContain("echo");

    const result = await rc.update({ scripts: { registry: { scripts: [scriptEntry()] } } });
    expect(result.applied).toEqual(["scripts.registry"]);
    expect(toolSelectionPrompt(provider.scripts)).toContain("echo: Repite los argumentos.");
    expect(await provider.call({ tool: "run_script", args: { script: "echo", args: { days: 3 } } })).toContain("3");
  });

  it("persists MCP changes but flags them as needing a restart", async () => {
    const rc = await make();
    const result = await rc.update({ mcp: { serverCommand: "npx", serverArgs: ["-y", "srv"], callTimeoutMs: 9000 } });
    expect(result.applied).toEqual([]);
    expect(result.restartRequired).toEqual(["mcp.serverCommand", "mcp.serverArgs", "mcp.callTimeoutMs"]);
    expect(rc.view().pendingRestart).toEqual(["mcp.serverCommand", "mcp.serverArgs", "mcp.callTimeoutMs"]);
    await rc.update({ mcp: { serverCommand: null, serverArgs: null, callTimeoutMs: null } });
    expect(rc.view().pendingRestart).toEqual([]);
  });
});

describe("secrets", () => {
  it("stores the key write-only, enables anthropic and never shows it", async () => {
    const llmSeen: LlmSettings[] = [];
    const rc = await make({ LLM_MODEL: "m" }, { appliers: { llm: (s) => llmSeen.push(s) } });
    const set = await rc.setAnthropicApiKey(SECRET);
    expect(set.config.settings.llm.anthropicApiKey).toMatchObject({ set: true, source: "panel", updatedAt: expect.any(String) });
    await rc.update({ llm: { provider: "anthropic", anthropicModel: "claude-x" } });
    expect(rc.llmSettings()).toEqual({ provider: "anthropic", model: "claude-x", apiKey: SECRET });
    expect(llmSeen.at(-1)).toMatchObject({ provider: "anthropic", apiKey: SECRET });

    const everything = JSON.stringify([rc.view(), rc.audit(50), set]);
    expect(everything).not.toContain(SECRET);
    expect(rc.audit(50).find((row) => row.key === "llm.anthropicApiKey")).toMatchObject({ newValue: "***" });
  });

  it("refuses to delete the only key while anthropic is the provider", async () => {
    const rc = await make({ LLM_MODEL: "m" });
    await rc.setAnthropicApiKey(SECRET);
    await rc.update({ llm: { provider: "anthropic" } });
    expect(await issuesOf(rc.setAnthropicApiKey(null))).toEqual([expect.objectContaining({ path: "llm" })]);
    await rc.update({ llm: { provider: null } });
    const removed = await rc.setAnthropicApiKey(null);
    expect(removed.config.settings.llm.anthropicApiKey).toEqual({ set: false, source: "default" });
  });

  it("reports an env key as set without showing it", async () => {
    const rc = await make({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: SECRET });
    expect(rc.view().settings.llm.anthropicApiKey).toEqual({ set: true, source: "env" });
    expect(JSON.stringify(rc.view())).not.toContain(SECRET);
  });
});

describe("LLM test and model list", () => {
  it("runs one tiny completion with overrides and reports latency, or a safe error", async () => {
    const rc = await make(undefined, {
      createLlm: (settings) => async () => {
        if (settings.model === "broken") throw new Error(`boom with ${SECRET}`);
        return "OK";
      },
    });
    await rc.setAnthropicApiKey(SECRET);
    expect(await rc.testLlm({ model: "other" })).toMatchObject({ ok: true, model: "other @ http://localhost:11434/v1", latencyMs: expect.any(Number) });
    const failed = await rc.testLlm({ model: "broken" });
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("boom") });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
    expect(await issuesOf(rc.testLlm({ temperature: "hot" }))).not.toHaveLength(0);
  });

  it("times out a hanging model", async () => {
    const rc = await make(undefined, { createLlm: () => () => new Promise<string>(() => undefined), llmTestTimeoutMs: 20 });
    expect(await rc.testLlm({})).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/i) });
  });

  it("lists models only from a local openai-compatible server", async () => {
    const requested: string[] = [];
    const fetchFake = (async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "qwen3:8b" }, { id: "gemma3:4b" }] }), { status: 200 });
    }) as typeof fetch;
    const rc = await make(undefined, { fetch: fetchFake });
    expect(await rc.listModels()).toEqual({ models: ["qwen3:8b", "gemma3:4b"] });
    expect(requested).toEqual(["http://localhost:11434/v1/models"]);

    await rc.update({ llm: { baseUrl: "https://api.example.com/v1" } });
    expect(await rc.listModels()).toEqual({ models: [], reason: expect.stringMatching(/local/) });
    expect(requested).toHaveLength(1);
  });
});
