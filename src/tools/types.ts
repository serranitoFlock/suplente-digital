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

export interface ToolProvider {
  readonly name: string;
  /** Executes a validated read-only tool call and returns a JSON/text payload for the model. */
  call(call: ToolCall): Promise<string>;
  close?(): Promise<void>;
}

/** Parses the model's tool choice; returns null for "none", unknown tools or invalid arguments. */
export function parseToolCall(text: string): ToolCall | null {
  const raw = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }).safeParse(extractJson(text));
  if (!raw.success || !(raw.data.tool in toolArgSchemas)) return null;
  const tool = raw.data.tool as ToolName;
  const args = toolArgSchemas[tool].safeParse(raw.data.args);
  return args.success ? ({ tool, args: args.data } as ToolCall) : null;
}
