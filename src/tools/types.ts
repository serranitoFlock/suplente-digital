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

export type ToolName = keyof typeof toolArgSchemas;

export type ToolCall = {
  [K in ToolName]: { tool: K; args: z.output<(typeof toolArgSchemas)[K]> };
}[ToolName];

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
export const TOOL_POLICIES: Record<ToolName, ToolPolicy> = {
  get_ticket: { readOnly: true, permission: "always_allow" },
  search_tickets: { readOnly: true, permission: "always_allow" },
  list_failed_pipelines: { readOnly: true, permission: "always_allow" },
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
 * (`unavailable`), or the server answered with an MCP error result (`remote_error`).
 */
export type ToolFailureKind = "missing_tool" | "timeout" | "unavailable" | "remote_error";

/**
 * A tool call that failed for operational reasons (never a policy refusal: that stays `ToolNotAllowedError`).
 * The message is internal and never includes remote payloads; replies to requesters use fixed text.
 */
export class ToolCallError extends Error {
  constructor(
    readonly tool: ToolName,
    readonly kind: ToolFailureKind,
    message = `Tool "${tool}" failed (${kind}).`,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

/** Throws unless `tool` is an allowlisted, read-only tool. */
export function assertToolAllowed(tool: string, policies: Record<string, ToolPolicy> = TOOL_POLICIES): asserts tool is ToolName {
  const policy = Object.hasOwn(policies, tool) ? policies[tool] : undefined;
  if (!policy) throw new ToolNotAllowedError(tool);
  if (policy.readOnly !== true) throw new ToolNotAllowedError(tool, "is not read-only");
}

/** True when the tool may run without a human (`always_allow`). */
export function isAutoRunnable(tool: ToolName, policies: Record<ToolName, ToolPolicy> = TOOL_POLICIES): boolean {
  return policies[tool]?.readOnly === true && policies[tool].permission === "always_allow";
}

export interface ToolProvider {
  readonly name: string;
  /** Executes a validated read-only tool call and returns a JSON/text payload for the model. */
  call(call: ToolCall): Promise<string>;
  close?(): Promise<void>;
}

/** Parses the model's tool choice; returns null for "none", unknown tools or invalid arguments. */
export function parseToolCall(text: string): ToolCall | null {
  const raw = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }).safeParse(extractJson(text));
  if (!raw.success || !Object.hasOwn(toolArgSchemas, raw.data.tool)) return null;
  const tool = raw.data.tool as ToolName;
  const args = toolArgSchemas[tool].safeParse(raw.data.args);
  return args.success ? ({ tool, args: args.data } as ToolCall) : null;
}
