import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  createLlm as defaultCreateLlm,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_TEMPERATURE,
  describeLlm,
  describeLlmError,
  resolveLlmSettings,
  type Llm,
  type LlmSettings,
} from "./llm.js";
import { DEFAULT_MEMORY_TURNS, resolveMemoryTurns } from "./memory/conversation-memory.js";
import type { SettingsAuditEntry, SettingsStore, StoredSetting } from "./persistence/settings-store.js";
import { resolveShowCitations } from "./presentation/format-answer.js";
import { DEFAULT_CALL_TIMEOUT_MS, loadMcpToolsConfig, parseMcpToolsConfig, resolveCallTimeoutMs, type McpToolsConfig } from "./tools/mcp-config.js";
import { buildScriptRegistry, type ScriptRegistry } from "./tools/scripts.js";

/**
 * Runtime configuration: the settings the admin panel can change while the process runs.
 *
 * Precedence per field: a value stored from the panel (`settings` table) > `.env` / the config files
 * (`MCP_TOOLS_CONFIG`, `SCRIPTS_CONFIG`) > the built-in default. With an empty settings table the result is exactly
 * what the environment resolves today. Every change is validated with the existing resolvers (`resolveLlmSettings`,
 * the MCP mapping schema, `buildScriptRegistry` and its write guard) before anything is stored, then applied:
 * LLM, memory turns, citations and the script registry hot; MCP fields only after a restart.
 */

export type SettingSource = "panel" | "env" | "default";
type Apply = "hot" | "restart";

interface FieldDef {
  /** Environment variable of the env layer (file-based fields have none). */
  env?: string;
  /** Parses a non-empty env value (the existing resolvers, so `.env` errors read as today). */
  fromEnv?: (raw: string) => unknown;
  /** Panel value schema (patches); secrets have their own endpoint. */
  schema: z.ZodType;
  fallback: unknown;
  apply: Apply;
  secret?: boolean;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const httpUrl = z.url({ protocol: /^https?$/ }).max(500);
const document = z.record(z.string(), z.unknown());

/** `LLM_TEMPERATURE=abc` is only an error for the openai-compatible provider: keep the raw text for the resolver. */
const numberOrRaw = (raw: string): unknown => (Number.isFinite(Number(raw)) ? Number(raw) : raw);

const FIELDS = {
  "llm.provider": { env: "LLM_PROVIDER", schema: z.enum(["openai-compatible", "anthropic"]), fallback: "openai-compatible", apply: "hot" },
  "llm.baseUrl": { env: "LLM_BASE_URL", schema: httpUrl, fallback: DEFAULT_BASE_URL, apply: "hot" },
  "llm.model": { env: "LLM_MODEL", schema: text(200), fallback: null, apply: "hot" },
  "llm.temperature": { env: "LLM_TEMPERATURE", fromEnv: numberOrRaw, schema: z.number().min(0).max(2), fallback: DEFAULT_TEMPERATURE, apply: "hot" },
  "llm.disableThinking": { env: "LLM_DISABLE_THINKING", fromEnv: (raw) => raw.toLowerCase() !== "false", schema: z.boolean(), fallback: true, apply: "hot" },
  "llm.anthropicModel": { env: "ANTHROPIC_MODEL", schema: text(200), fallback: DEFAULT_ANTHROPIC_MODEL, apply: "hot" },
  "llm.anthropicApiKey": { env: "ANTHROPIC_API_KEY", schema: text(1000), fallback: null, apply: "hot", secret: true },
  "assistant.memoryTurns": { env: "MEMORY_TURNS", fromEnv: resolveMemoryTurns, schema: z.number().int().min(0).max(50), fallback: DEFAULT_MEMORY_TURNS, apply: "hot" },
  "assistant.showCitations": { env: "SHOW_CITATIONS", fromEnv: resolveShowCitations, schema: z.boolean(), fallback: false, apply: "hot" },
  "mcp.serverCommand": { env: "MCP_SERVER_COMMAND", schema: text(500), fallback: null, apply: "restart" },
  "mcp.serverArgs": { env: "MCP_SERVER_ARGS", fromEnv: (raw) => raw.split(/\s+/), schema: z.array(z.string().max(500)).max(50), fallback: [], apply: "restart" },
  "mcp.toolsMapping": { schema: document, fallback: null, apply: "restart" },
  "mcp.callTimeoutMs": { env: "MCP_CALL_TIMEOUT_MS", fromEnv: resolveCallTimeoutMs, schema: z.number().int().min(100).max(600_000), fallback: DEFAULT_CALL_TIMEOUT_MS, apply: "restart" },
  "scripts.registry": { schema: document, fallback: { scripts: [] }, apply: "hot" },
} satisfies Record<string, FieldDef>;

export type SettingKey = keyof typeof FIELDS;
export const SETTING_KEYS = Object.keys(FIELDS) as SettingKey[];
export const SECRET_SETTING_KEYS: readonly SettingKey[] = SETTING_KEYS.filter((key) => (FIELDS[key] as FieldDef).secret);
const ANTHROPIC_KEY = "llm.anthropicApiKey" satisfies SettingKey;

/** The typed effective settings (secret included: never send this object to a client). */
export interface RuntimeSettings {
  llm: {
    provider: string;
    baseUrl: string;
    model: string | null;
    temperature: number;
    disableThinking: boolean;
    anthropicModel: string;
    anthropicApiKey: string | null;
  };
  assistant: { memoryTurns: number; showCitations: boolean };
  mcp: { serverCommand: string | null; serverArgs: string[]; toolsMapping: McpToolsConfig | null; callTimeoutMs: number };
  scripts: { registry: unknown };
}

/** The `.env` / config-file layer, read once at startup. */
export interface RuntimeBaseline {
  values: Partial<Record<SettingKey, unknown>>;
  /** `LLM_API_KEY` (openai-compatible servers that need a key): env-only, never shown. */
  llmApiKey?: string;
}

export interface BaselineSources {
  env: Record<string, string | undefined>;
  /** `MCP_TOOLS_CONFIG` path (optional file). */
  mcpToolsPath: string;
  /** `SCRIPTS_CONFIG` path (optional file). */
  scriptsPath: string;
}

/** Reads the env layer: variables through the existing resolvers, plus the MCP mapping and script registry files. */
export async function loadBaseline({ env, mcpToolsPath, scriptsPath }: BaselineSources): Promise<RuntimeBaseline> {
  const values: Partial<Record<SettingKey, unknown>> = {};
  for (const key of SETTING_KEYS) {
    const def = FIELDS[key] as FieldDef;
    const raw = def.env ? env[def.env]?.trim() : undefined;
    if (raw) values[key] = def.fromEnv ? def.fromEnv(raw) : raw;
  }
  const mapping = await loadMcpToolsConfig(mcpToolsPath);
  if (mapping) values["mcp.toolsMapping"] = mapping;
  const registry = await readJsonFile(scriptsPath, "Script registry");
  if (registry !== undefined) values["scripts.registry"] = registry;
  return { values, llmApiKey: env.LLM_API_KEY?.trim() || undefined };
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${label} at ${path} is not valid JSON.`);
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** A rejected change: nothing was stored or applied. */
export class ConfigValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`Invalid configuration: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
}

/** What to do when a hot setting changes (wired by `createAssistant`). */
export interface RuntimeAppliers {
  llm?(settings: LlmSettings): void;
  memoryTurns?(turns: number): void;
  showCitations?(show: boolean): void;
  scripts?(registry: ScriptRegistry): void;
}

export interface RuntimeConfigOptions {
  store: SettingsStore;
  baseline: RuntimeBaseline;
  /** Repo root the script commands and cwd resolve against. */
  scriptsRoot: string;
  appliers?: RuntimeAppliers;
  /** Builds a model for `testLlm` (tests plug in a fake). */
  createLlm?: (settings: LlmSettings) => Llm;
  /** Used by `listModels` (tests plug in a fake). */
  fetch?: typeof fetch;
  /** Warnings for script entries skipped at startup (default `console.warn`). */
  warn?: (message: string) => void;
  /** Bound of `testLlm` (default 20 s). */
  llmTestTimeoutMs?: number;
  /** Bound of `listModels` (default 5 s). */
  modelsTimeoutMs?: number;
}

export interface FieldView {
  value: unknown;
  source: SettingSource;
  /** True when a change only takes effect after restarting the process. */
  restartRequired: boolean;
  /** When the panel value was stored (only for `source: "panel"`). */
  updatedAt?: string;
}

/** A secret is never returned: only whether it is set and where it comes from. */
export interface SecretView {
  set: boolean;
  source: SettingSource;
  updatedAt?: string;
}

type GroupOf<K extends string> = K extends `${infer G}.${string}` ? G : never;
type NameOf<K extends string, G extends string> = K extends `${G}.${infer N}` ? N : never;

/** `{ llm: { model: FieldView, anthropicApiKey: SecretView, ... }, assistant: {...}, mcp: {...}, scripts: {...} }`. */
export type SettingsView = {
  [G in GroupOf<SettingKey>]: { [N in NameOf<SettingKey, G>]: `${G}.${N}` extends typeof ANTHROPIC_KEY ? SecretView : FieldView };
};

export interface ConfigView {
  settings: SettingsView;
  /** Read-only facts for the panel. */
  llm: { description: string };
  scripts: { registered: string[]; rejected: { id: string; reason: string }[] };
  /** Restart-only keys whose effective value differs from the one this process started with. */
  pendingRestart: SettingKey[];
}

export interface ConfigUpdateResult {
  /** Changed keys already in effect. */
  applied: SettingKey[];
  /** Changed keys stored but only used after a restart. */
  restartRequired: SettingKey[];
  config: ConfigView;
}

export type LlmTestResult = { ok: true; latencyMs: number; model: string } | { ok: false; latencyMs: number; model: string; error: string };

export interface ModelList {
  models: string[];
  reason?: string;
}

interface Resolved {
  values: Record<SettingKey, unknown>;
  sources: Record<SettingKey, SettingSource>;
  updatedAt: Partial<Record<SettingKey, string>>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_MODELS = 500;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function issuesFromZod(error: z.ZodError, prefix: string[] = []): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: [...prefix, ...issue.path.map(String)].join("."), message: issue.message }));
}

/** Patch schema: `{ group: { name: value | null } }`, every key optional; `null` resets to the env/default. */
const PatchSchema = (() => {
  const groups: Record<string, Record<string, z.ZodType>> = {};
  for (const key of SETTING_KEYS) {
    const def = FIELDS[key] as FieldDef;
    if (def.secret) continue;
    const [group, name] = key.split(".") as [string, string];
    (groups[group] ??= {})[name] = def.schema.nullable().optional();
  }
  return z.strictObject(Object.fromEntries(Object.entries(groups).map(([group, shape]) => [group, z.strictObject(shape).optional()])));
})();

/** `testLlm` overrides: the LLM fields (no nulls, no secret). */
const LlmOverridesSchema = z.strictObject(
  Object.fromEntries(
    SETTING_KEYS.filter((key) => key.startsWith("llm.") && !(FIELDS[key] as FieldDef).secret).map((key) => [key.slice(4), (FIELDS[key] as FieldDef).schema.optional()]),
  ),
);

function resolveLayers(panel: Map<string, StoredSetting>, baseline: RuntimeBaseline): Resolved {
  const values = {} as Record<SettingKey, unknown>;
  const sources = {} as Record<SettingKey, SettingSource>;
  const updatedAt: Partial<Record<SettingKey, string>> = {};
  for (const key of SETTING_KEYS) {
    const stored = panel.get(key);
    if (stored) {
      values[key] = stored.value;
      sources[key] = "panel";
      updatedAt[key] = stored.updatedAt;
    } else if (Object.hasOwn(baseline.values, key)) {
      values[key] = baseline.values[key];
      sources[key] = "env";
    } else {
      values[key] = (FIELDS[key] as FieldDef).fallback;
      sources[key] = "default";
    }
  }
  return { values, sources, updatedAt };
}

/** Composes the LLM fields into the environment shape and lets the existing resolver decide. */
function resolveLlm(values: Record<SettingKey, unknown>, llmApiKey: string | undefined): LlmSettings {
  const str = (value: unknown) => (value === null || value === undefined ? undefined : String(value));
  const settings = resolveLlmSettings({
    LLM_PROVIDER: str(values["llm.provider"]),
    LLM_BASE_URL: str(values["llm.baseUrl"]),
    LLM_MODEL: str(values["llm.model"]),
    LLM_TEMPERATURE: str(values["llm.temperature"]),
    LLM_DISABLE_THINKING: str(values["llm.disableThinking"]),
    ANTHROPIC_MODEL: str(values["llm.anthropicModel"]),
    ANTHROPIC_API_KEY: str(values[ANTHROPIC_KEY]),
    LLM_API_KEY: llmApiKey,
  });
  if (settings.provider !== "anthropic") return settings;
  const apiKey = str(values[ANTHROPIC_KEY]);
  return apiKey ? { ...settings, apiKey } : settings;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class RuntimeConfig {
  #current: Resolved;
  #llm: LlmSettings;
  #registry: ScriptRegistry;
  #appliers: RuntimeAppliers;
  /** Restart-only values this process runs with. */
  readonly #startup: Partial<Record<SettingKey, unknown>>;
  /** Serializes changes (validation is async). */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly options: RuntimeConfigOptions,
    current: Resolved,
    llm: LlmSettings,
    registry: ScriptRegistry,
  ) {
    this.#current = current;
    this.#llm = llm;
    this.#registry = registry;
    this.#appliers = options.appliers ?? {};
    this.#startup = Object.fromEntries(SETTING_KEYS.filter((key) => FIELDS[key].apply === "restart").map((key) => [key, current.values[key]]));
  }

  /** Resolves the effective configuration at startup; throws (like `.env` errors today) when it is invalid. */
  static async create(options: RuntimeConfigOptions): Promise<RuntimeConfig> {
    const current = resolveLayers(options.store.entries(), options.baseline);
    const fromPanel = (prefix: string) => SETTING_KEYS.filter((key) => key.startsWith(prefix) && current.sources[key] === "panel");
    const hint = (keys: string[]) => (keys.length ? ` (values set from the admin panel: ${keys.join(", ")})` : "");

    let llm: LlmSettings;
    try {
      llm = resolveLlm(current.values, options.baseline.llmApiKey);
    } catch (error) {
      throw new Error(`${(error as Error).message}${hint(fromPanel("llm."))}`, { cause: error });
    }
    const mapping = current.values["mcp.toolsMapping"];
    if (mapping !== null && current.sources["mcp.toolsMapping"] === "panel") parseMcpToolsConfig(mapping, "MCP tools mapping set from the admin panel");
    // At startup a skipped entry only warns (as with the file today); a panel change with a rejected entry is refused.
    const registry = await buildScriptRegistry(current.values["scripts.registry"], options.scriptsRoot, { warn: options.warn }, "Script registry");
    return new RuntimeConfig(options, current, llm, registry);
  }

  setAppliers(appliers: RuntimeAppliers): void {
    this.#appliers = appliers;
  }

  /** The effective settings, secret included (server side only). */
  effective(): RuntimeSettings {
    const nested: Record<string, Record<string, unknown>> = {};
    for (const key of SETTING_KEYS) {
      const [group, name] = key.split(".") as [string, string];
      (nested[group] ??= {})[name] = this.#current.values[key];
    }
    return nested as unknown as RuntimeSettings;
  }

  llmSettings(): LlmSettings {
    return this.#llm;
  }

  registry(): ScriptRegistry {
    return this.#registry;
  }

  /** Safe for API responses: secrets only as `{ set, source, updatedAt }`. */
  view(): ConfigView {
    const settings: Record<string, Record<string, FieldView | SecretView>> = {};
    const { values, sources, updatedAt } = this.#current;
    for (const key of SETTING_KEYS) {
      const def = FIELDS[key] as FieldDef;
      const [group, name] = key.split(".") as [string, string];
      const stamp = updatedAt[key] ? { updatedAt: updatedAt[key] } : {};
      (settings[group] ??= {})[name] = def.secret
        ? { set: values[key] !== null && values[key] !== undefined, source: sources[key], ...stamp }
        : { value: values[key], source: sources[key], restartRequired: def.apply === "restart", ...stamp };
    }
    return {
      settings: settings as SettingsView,
      llm: { description: describeLlm(this.#llm) },
      scripts: { registered: this.#registry.ids(), rejected: this.#registry.rejected.map(({ id, reason }) => ({ id, reason })) },
      pendingRestart: SETTING_KEYS.filter((key) => Object.hasOwn(this.#startup, key) && !same(this.#startup[key], values[key])),
    };
  }

  /** Applies a partial patch (`null` resets a key). Throws `ConfigValidationError` and changes nothing when invalid. */
  update(patch: unknown): Promise<ConfigUpdateResult> {
    return this.#serial(async () => {
      const parsed = PatchSchema.safeParse(patch ?? {});
      if (!parsed.success) throw new ConfigValidationError(issuesFromZod(parsed.error));
      const changes: Partial<Record<SettingKey, unknown>> = {};
      for (const [group, fields] of Object.entries(parsed.data as Record<string, Record<string, unknown> | undefined>)) {
        for (const [name, value] of Object.entries(fields ?? {})) if (value !== undefined) changes[`${group}.${name}` as SettingKey] = value;
      }
      return this.#commit(changes);
    });
  }

  /** Sets (or with `null` removes) the Anthropic API key. The value is never returned or audited. */
  setAnthropicApiKey(value: string | null): Promise<ConfigUpdateResult> {
    return this.#serial(async () => {
      if (value !== null) {
        const parsed = FIELDS[ANTHROPIC_KEY].schema.safeParse(value);
        if (!parsed.success) throw new ConfigValidationError([{ path: "value", message: "Must be a non-empty string of at most 1000 characters." }]);
        value = parsed.data as string;
      }
      return this.#commit({ [ANTHROPIC_KEY]: value });
    });
  }

  audit(limit = 50): SettingsAuditEntry[] {
    return this.options.store.audit(limit);
  }

  /** One tiny completion with the current LLM settings plus `overrides`, bounded in time. Errors are safe messages. */
  async testLlm(overrides: unknown = {}): Promise<LlmTestResult> {
    const parsed = LlmOverridesSchema.safeParse(overrides ?? {});
    if (!parsed.success) throw new ConfigValidationError(issuesFromZod(parsed.error, ["overrides"]));
    const values = { ...this.#current.values };
    for (const [name, value] of Object.entries(parsed.data)) if (value !== undefined) values[`llm.${name}` as SettingKey] = value;
    let settings: LlmSettings;
    try {
      settings = resolveLlm(values, this.options.baseline.llmApiKey);
    } catch (error) {
      throw new ConfigValidationError([{ path: "overrides", message: (error as Error).message }]);
    }
    const model = describeLlm(settings);
    const started = Date.now();
    try {
      const llm = (this.options.createLlm ?? defaultCreateLlm)(settings);
      const timeoutMs = this.options.llmTestTimeoutMs ?? 20_000;
      await withTimeout(llm("Reply with the single word OK.", "ping"), timeoutMs, `The model did not answer: timed out after ${timeoutMs} ms.`);
      return { ok: true, latencyMs: Date.now() - started, model };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, model, error: this.#scrub(describeLlmError(error, settings)) };
    }
  }

  /**
   * Model ids from the configured local OpenAI-compatible server (`GET <baseUrl>/models`; Ollama supports it).
   * Only the configured base URL, only on localhost/127.0.0.1/::1: the request never supplies a URL.
   */
  async listModels(): Promise<ModelList> {
    const settings = this.#llm;
    if (settings.provider !== "openai-compatible") return { models: [], reason: "Model listing is only available for the openai-compatible provider." };
    let url: URL;
    try {
      url = new URL(settings.baseUrl);
    } catch {
      return { models: [], reason: "The base URL is not valid." };
    }
    if (!LOCAL_HOSTS.has(url.hostname)) return { models: [], reason: "Model listing is only available for a local model server (localhost or 127.0.0.1)." };
    const doFetch = this.options.fetch ?? fetch;
    try {
      const response = await doFetch(`${settings.baseUrl.replace(/\/+$/, "")}/models`, {
        redirect: "error",
        signal: AbortSignal.timeout(this.options.modelsTimeoutMs ?? 5_000),
      });
      if (!response.ok) return { models: [], reason: `The model server answered ${response.status}.` };
      const body = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200) })) }).safeParse(await response.json());
      if (!body.success) return { models: [], reason: "The model server did not return an OpenAI-compatible model list." };
      return { models: body.data.data.slice(0, MAX_MODELS).map((model) => model.id) };
    } catch {
      return { models: [], reason: "Cannot reach the local model server." };
    }
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Never let a secret value reach a message. */
  #scrub(message: string): string {
    let out = message;
    for (const secret of [this.#current.values[ANTHROPIC_KEY], this.options.baseline.llmApiKey]) {
      if (typeof secret === "string" && secret.length >= 4 && secret !== "not-needed") out = out.split(secret).join("***");
    }
    return out;
  }

  /** Validates the candidate configuration, stores it (audited), then applies the hot changes. */
  async #commit(changes: Partial<Record<SettingKey, unknown>>): Promise<ConfigUpdateResult> {
    const { store, baseline, scriptsRoot } = this.options;
    const candidatePanel = store.entries();
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) candidatePanel.delete(key);
      else candidatePanel.set(key, { value, updatedAt: "" });
    }
    const next = resolveLayers(candidatePanel, baseline);
    const issues: ValidationIssue[] = [];

    let llm = this.#llm;
    try {
      llm = resolveLlm(next.values, baseline.llmApiKey);
    } catch (error) {
      issues.push({ path: "llm", message: (error as Error).message });
    }

    const mapping = next.values["mcp.toolsMapping"];
    if ("mcp.toolsMapping" in changes && mapping !== null) {
      try {
        parseMcpToolsConfig(mapping, "mcp.toolsMapping");
      } catch (error) {
        issues.push({ path: "mcp.toolsMapping", message: (error as Error).message });
      }
    }

    let registry = this.#registry;
    if ("scripts.registry" in changes) {
      const fromPanel = changes["scripts.registry"] !== null;
      try {
        // A reset rebuilds the file registry as at startup (skips warn); a panel registry must be entirely valid.
        registry = await buildScriptRegistry(next.values["scripts.registry"], scriptsRoot, { warn: fromPanel ? () => undefined : this.options.warn }, "scripts.registry");
        if (fromPanel) for (const { id, reason } of registry.rejected) issues.push({ path: `scripts.registry.${id}`, message: reason });
      } catch (error) {
        issues.push({ path: "scripts.registry", message: (error as Error).message });
      }
    }

    if (issues.length > 0) throw new ConfigValidationError(issues);

    store.write(changes);
    const before = this.#current.values;
    this.#current = resolveLayers(store.entries(), baseline);
    const changed = SETTING_KEYS.filter((key) => !same(before[key], this.#current.values[key]));

    if (!same(llm, this.#llm)) {
      this.#llm = llm;
      this.#appliers.llm?.(llm);
    }
    if (changed.includes("assistant.memoryTurns")) this.#appliers.memoryTurns?.(this.#current.values["assistant.memoryTurns"] as number);
    if (changed.includes("assistant.showCitations")) this.#appliers.showCitations?.(this.#current.values["assistant.showCitations"] as boolean);
    if (registry !== this.#registry) {
      this.#registry = registry;
      this.#appliers.scripts?.(registry);
    }
    return {
      applied: changed.filter((key) => FIELDS[key].apply === "hot"),
      restartRequired: changed.filter((key) => FIELDS[key].apply === "restart"),
      config: this.view(),
    };
  }
}
