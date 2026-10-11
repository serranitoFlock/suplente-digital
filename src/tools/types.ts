import { z } from "zod";
import { extractJson } from "../llm.js";

/**
 * Read-only tool catalog. Every provider (mock or MCP-backed) exposes exactly
 * these tools; there are deliberately no write/transition/delete tools.
 */
export const toolArgSchemas = {
  get_ticket: z.object({ key: z.string().regex(/^[A-Za-z]+-\d+$/, "Ticket key like DEMO-101") }),
  search_tickets: z.object({ query: z.string().min(2) }),
  list_failed_pipelines: z.object({ sinceDays: z.number().int().min(1).max(90).default(7) }),
} as const;

/** Tools served by a provider (mock or MCP). */
export type ToolName = keyof typeof toolArgSchemas;

/**
 * The one catalog tool that runs human-registered read-only scripts (see `scripts.ts`). Its arguments are
 * only shaped here; the script id and its `args` are validated against the loaded registry at call time.
 */
export const SCRIPT_TOOL = "run_script";
export const scriptToolArgSchema = z.object({
  script: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type ScriptToolArgs = z.output<typeof scriptToolArgSchema>;

/** Every tool the model may choose: the provider tools plus `run_script`. */
export type CatalogToolName = ToolName | typeof SCRIPT_TOOL;

export type ProviderToolCall = {
  [K in ToolName]: { tool: K; args: z.output<(typeof toolArgSchemas)[K]> };
}[ToolName];
export type ScriptToolCall = { tool: typeof SCRIPT_TOOL; args: ScriptToolArgs };
export type ToolCall = ProviderToolCall | ScriptToolCall;

export const toolDescriptions: Record<ToolName, string> = {
  get_ticket: 'Estado, responsable y último comentario de un ticket. args: {"key": "DEMO-101"}',
  search_tickets: 'Busca tickets por texto. args: {"query": "cdn"}',
  list_failed_pipelines: 'Lista jobs de CI fallidos en los últimos N días. args: {"sinceDays": 7}',
};

export type ToolPermission = "always_allow" | "always_ask";

export interface ToolPolicy {
  /** Every allowlisted tool must be read-only; there is no write path to opt into. */
  readOnly: true;
  /** `always_allow`: the task node may run it unattended. `always_ask`: never auto-run; a human must do it. */
  permission: ToolPermission;
}

/**
 * Explicit allowlist (least privilege). Providers refuse any tool that is not listed here,
 * even if the underlying MCP server exposes it.
 */
export const TOOL_POLICIES: Record<CatalogToolName, ToolPolicy> = {
  get_ticket: { readOnly: true, permission: "always_allow" },
  search_tickets: { readOnly: true, permission: "always_allow" },
  list_failed_pipelines: { readOnly: true, permission: "always_allow" },
  // Only scripts a human registered with `readOnly: true` and that pass the static write guard can run.
  run_script: { readOnly: true, permission: "always_allow" },
};

export class ToolNotAllowedError extends Error {
  constructor(tool: string, reason = "is not in the read-only tool allowlist") {
    super(`Tool "${tool}" ${reason}.`);
    this.name = "ToolNotAllowedError";
  }
}

/**
 * Why a read-only tool call could not be completed: the remote tool is not exposed (`missing_tool`),
 * the call took longer than the timeout (`timeout`), the server crashed or the connection closed
 * (`unavailable`), the server answered with an MCP error result (`remote_error`), or a registered
 * script exited with a non-zero status (`script_error`).
 */
export type ToolFailureKind = "missing_tool" | "timeout" | "unavailable" | "remote_error" | "script_error";

/**
 * A tool call that failed for operational reasons (never a policy refusal: that stays `ToolNotAllowedError`).
 * The message is internal and never includes remote payloads; replies to requesters use fixed text.
 */
export class ToolCallError extends Error {
  constructor(
    readonly tool: CatalogToolName,
    readonly kind: ToolFailureKind,
    message = `Tool "${tool}" failed (${kind}).`,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

/** Throws unless `tool` is an allowlisted, read-only tool. */
export function assertToolAllowed(tool: string, policies: Record<string, ToolPolicy> = TOOL_POLICIES): asserts tool is CatalogToolName {
  const policy = Object.hasOwn(policies, tool) ? policies[tool] : undefined;
  if (!policy) throw new ToolNotAllowedError(tool);
  if (policy.readOnly !== true) throw new ToolNotAllowedError(tool, "is not read-only");
}

/** True when the tool may run without a human (`always_allow`). */
export function isAutoRunnable(tool: CatalogToolName, policies: Record<CatalogToolName, ToolPolicy> = TOOL_POLICIES): boolean {
  return policies[tool]?.readOnly === true && policies[tool].permission === "always_allow";
}

/** What the task node needs to offer `run_script` and validate a call (implemented by `ScriptRegistry`). */
export interface ScriptCatalog {
  readonly size: number;
  /** One model-facing line per registered script: id, description and params. */
  describe(): string[];
  /** The call with validated args (defaults applied), or null for an unknown id or invalid args. */
  resolve(args: ScriptToolArgs): ScriptToolArgs | null;
}

export interface ToolProvider {
  readonly name: string;
  /** Registered read-only scripts, when this provider serves `run_script` (absent: no scripts). */
  readonly scripts?: ScriptCatalog;
  /** Executes a validated read-only tool call and returns a JSON/text payload for the model. */
  call(call: ToolCall): Promise<string>;
  close?(): Promise<void>;
}

/** Parses the model's tool choice; returns null for "none", unknown tools or invalid arguments. */
export function parseToolCall(text: string): ToolCall | null {
  const raw = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }).safeParse(extractJson(text));
  if (!raw.success) return null;
  if (raw.data.tool === SCRIPT_TOOL) {
    const args = scriptToolArgSchema.safeParse(raw.data.args);
    return args.success ? { tool: SCRIPT_TOOL, args: args.data } : null;
  }
  if (!Object.hasOwn(toolArgSchemas, raw.data.tool)) return null;
  const tool = raw.data.tool as ToolName;
  const args = toolArgSchemas[tool].safeParse(raw.data.args);
  return args.success ? ({ tool, args: args.data } as ToolCall) : null;
}
