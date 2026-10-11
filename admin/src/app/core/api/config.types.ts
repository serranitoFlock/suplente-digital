/** Mirrors of the admin-scope runtime configuration views (`src/runtime-config.ts`). */

export type SettingSource = 'panel' | 'env' | 'default';

export interface FieldView<T = unknown> {
  value: T;
  source: SettingSource;
  /** True when a change only takes effect after restarting the server. */
  restartRequired: boolean;
  /** ISO 8601; only for `source: "panel"`. */
  updatedAt?: string;
}

/** A secret is never returned: only whether it is set and where it comes from. */
export interface SecretView {
  set: boolean;
  source: SettingSource;
  updatedAt?: string;
}

export type LlmProvider = 'openai-compatible' | 'anthropic';

export interface SettingsView {
  llm: {
    provider: FieldView<LlmProvider>;
    baseUrl: FieldView<string>;
    model: FieldView<string | null>;
    temperature: FieldView<number>;
    disableThinking: FieldView<boolean>;
    anthropicModel: FieldView<string>;
    anthropicApiKey: SecretView;
  };
  assistant: { memoryTurns: FieldView<number>; showCitations: FieldView<boolean> };
  mcp: {
    serverCommand: FieldView<string | null>;
    serverArgs: FieldView<string[]>;
    toolsMapping: FieldView<Record<string, unknown> | null>;
    callTimeoutMs: FieldView<number>;
  };
  scripts: { registry: FieldView<unknown> };
}

export type SectionId = keyof SettingsView;

export interface ConfigView {
  settings: SettingsView;
  /** Read-only facts: the current model (e.g. `qwen3:8b @ http://localhost:11434/v1`). */
  llm: { description: string };
  scripts: { registered: string[]; rejected: { id: string; reason: string }[] };
  /** Restart-only keys (`mcp.serverCommand`, ...) whose stored value differs from the running one. */
  pendingRestart: string[];
}

/** `PUT /v1/config`: `{ group: { name: value | null } }`; `null` resets the key to `.env` / default. */
export type ConfigPatch = Partial<Record<SectionId, Record<string, unknown>>>;

export interface ConfigUpdateResult {
  /** Changed keys already in effect. */
  applied: string[];
  /** Changed keys stored but only used after a restart. */
  restartRequired: string[];
  config: ConfigView;
}

export interface ValidationIssue {
  /** Dotted path, e.g. `llm.temperature` or `scripts.registry.<id>`. */
  path: string;
  message: string;
}

export interface LlmTestOverrides {
  provider?: LlmProvider;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  disableThinking?: boolean;
  anthropicModel?: string;
}

export type LlmTestResult =
  | { ok: true; latencyMs: number; model: string }
  | { ok: false; latencyMs: number; model: string; error: string };

export interface ModelList {
  models: string[];
  reason?: string;
}

export interface AuditEntry {
  id: number;
  key: string;
  oldValue: unknown;
  newValue: unknown;
  changedAt: string;
  actor: string;
}

export interface AuditList {
  entries: AuditEntry[];
}
