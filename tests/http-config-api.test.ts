import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/http/server.js";
import { PendingStore } from "../src/pending/store.js";
import { SETTINGS_SCHEMA, SettingsStore } from "../src/persistence/settings-store.js";
import { openDatabase } from "../src/persistence/sqlite.js";
import { loadBaseline, RuntimeConfig } from "../src/runtime-config.js";
import { AssistantService } from "../src/service/assistant-service.js";
import { ControlledRunner } from "./helpers/controlled-runner.js";

const CLIENT = "client-token-0123456789abcdef";
const ADMIN = "admin-token-0123456789abcdef0";
const SECRET = "sk-ant-api03-http-secret-value";

let dir: string;
let db: DatabaseSync;
let server: Server;
let base: string;
let logLines: string[];
let fetched: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "http-config-"));
  db = openDatabase(join(dir, "assistant.db"), [SETTINGS_SCHEMA]);
  const store = new SettingsStore(db, { secretKeys: ["llm.anthropicApiKey"] });
  const baseline = await loadBaseline({ env: { LLM_MODEL: "env-model" }, mcpToolsPath: join(dir, "none.json"), scriptsPath: join(dir, "none.json") });
  fetched = [];
  const config = await RuntimeConfig.create({
    store,
    baseline,
    scriptsRoot: process.cwd(),
    warn: () => undefined,
    createLlm: (settings) => async () => {
      if (settings.model === "broken") throw new Error("connection refused");
      return "OK";
    },
    fetch: (async (url: string) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "qwen3:8b" }] }));
    }) as typeof fetch,
  });
  logLines = [];
  server = createApiServer({
    service: new AssistantService(new ControlledRunner()),
    pending: new PendingStore(join(dir, "pending.json")),
    tokens: { client: CLIENT, admin: ADMIN },
    config,
    log: (line) => logLines.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (db.isOpen) db.close();
  await rm(dir, { recursive: true, force: true });
});

async function call(path: string, { token = ADMIN, method = "GET", body }: { token?: string | null; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as any) : undefined };
}

const ENDPOINTS: [string, string, unknown?][] = [
  ["GET", "/v1/config"],
  ["PUT", "/v1/config", { assistant: { memoryTurns: 1 } }],
  ["PUT", "/v1/config/secrets/anthropic-api-key", { value: SECRET }],
  ["DELETE", "/v1/config/secrets/anthropic-api-key"],
  ["POST", "/v1/config/llm/test", {}],
  ["GET", "/v1/config/models"],
  ["GET", "/v1/config/audit"],
];

describe("config API", () => {
  it.each(ENDPOINTS)("%s %s is admin-only (401 without a token, 403 for the client)", async (method, path, body) => {
    expect((await call(path, { method, body, token: null })).status).toBe(401);
    expect((await call(path, { method, body, token: CLIENT })).status).toBe(403);
  });

  it("GET returns effective values with their sources", async () => {
    const { status, json } = await call("/v1/config");
    expect(status).toBe(200);
    expect(json.settings.llm.model).toMatchObject({ value: "env-model", source: "env", restartRequired: false });
    expect(json.settings.mcp.serverCommand).toMatchObject({ source: "default", restartRequired: true });
    expect(json.settings.llm.anthropicApiKey).toEqual({ set: false, source: "default" });
    expect(json.llm.description).toBe("env-model @ http://localhost:11434/v1");
  });

  it("PUT applies a partial patch and says what was applied and what needs a restart", async () => {
    const { status, json } = await call("/v1/config", { method: "PUT", body: { llm: { model: "qwen3:8b" }, mcp: { serverCommand: "npx" } } });
    expect(status).toBe(200);
    expect(json.applied).toEqual(["llm.model"]);
    expect(json.restartRequired).toEqual(["mcp.serverCommand"]);
    expect(json.config.settings.llm.model).toMatchObject({ value: "qwen3:8b", source: "panel" });
    expect(json.config.pendingRestart).toEqual(["mcp.serverCommand"]);
  });

  it("PUT answers 422 with paths and persists nothing on invalid input", async () => {
    const bad = await call("/v1/config", { method: "PUT", body: { llm: { temperature: -2 } } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.issues).toEqual([expect.objectContaining({ path: "llm.temperature" })]);
    const writeCapable = await call("/v1/config", {
      method: "PUT",
      body: { scripts: { registry: { scripts: [{ id: "w", description: "x", command: "tests/fixtures/scripts/echo-args.sh", readOnly: false }] } } },
    });
    expect(writeCapable.status).toBe(422);
    expect(writeCapable.json.error.issues[0].path).toBe("scripts.registry.w");
    expect((await call("/v1/config/audit")).json.entries).toEqual([]);
  });

  it("the secret is write-only: never echoed by PUT, GET, audit or the request log", async () => {
    const put = await call("/v1/config/secrets/anthropic-api-key", { method: "PUT", body: { value: SECRET } });
    expect(put.status).toBe(200);
    expect(put.json.config.settings.llm.anthropicApiKey).toMatchObject({ set: true, source: "panel" });
    const switched = await call("/v1/config", { method: "PUT", body: { llm: { provider: "anthropic" } } });
    expect(switched.status).toBe(200);
    const texts = [put.text, switched.text, (await call("/v1/config")).text, (await call("/v1/config/audit")).text, logLines.join("\n")];
    for (const text of texts) expect(text).not.toContain(SECRET);

    expect((await call("/v1/config/secrets/anthropic-api-key", { method: "DELETE" })).status).toBe(422);
    await call("/v1/config", { method: "PUT", body: { llm: { provider: null } } });
    const deleted = await call("/v1/config/secrets/anthropic-api-key", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.json.config.settings.llm.anthropicApiKey).toEqual({ set: false, source: "default" });
    expect((await call("/v1/config/secrets/anthropic-api-key", { method: "PUT", body: { value: "" } })).status).toBe(422);
  });

  it("tests the LLM with optional overrides", async () => {
    expect((await call("/v1/config/llm/test", { method: "POST", body: {} })).json).toMatchObject({ ok: true, model: "env-model @ http://localhost:11434/v1" });
    const broken = await call("/v1/config/llm/test", { method: "POST", body: { overrides: { model: "broken" } } });
    expect(broken.status).toBe(200);
    expect(broken.json).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("lists models only for a local base URL and never takes a URL from the request", async () => {
    const local = await call("/v1/config/models?baseUrl=http://evil.example");
    expect(local.json).toEqual({ models: ["qwen3:8b"] });
    expect(fetched).toEqual(["http://localhost:11434/v1/models"]);
    await call("/v1/config", { method: "PUT", body: { llm: { baseUrl: "http://10.0.0.5:11434/v1" } } });
    const remote = await call("/v1/config/models");
    expect(remote.json.models).toEqual([]);
    expect(remote.json.reason).toEqual(expect.any(String));
    expect(fetched).toHaveLength(1);
  });

  it("returns the audit, newest first", async () => {
    await call("/v1/config", { method: "PUT", body: { assistant: { memoryTurns: 1 } } });
    await call("/v1/config", { method: "PUT", body: { assistant: { memoryTurns: 2 } } });
    const { json } = await call("/v1/config/audit?limit=1");
    expect(json.entries).toEqual([expect.objectContaining({ key: "assistant.memoryTurns", oldValue: 1, newValue: 2, actor: "admin" })]);
  });
});
