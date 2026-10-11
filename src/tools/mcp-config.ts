import { readFile } from "node:fs/promises";
import { z } from "zod";
import { toolArgSchemas, type ToolName } from "./types.js";

/**
 * Per-tool MCP mapping (`MCP_TOOLS_CONFIG`, default `config/mcp-tools.local.json`, gitignored).
 * Real MCP servers name tools and arguments their own way (e.g. Atlassian: `jira_get_issue {issue_key}`),
 * so each local tool can declare the remote tool `name` and how to build each remote argument:
 *
 * ```json
 * { "tools": {
 *     "get_ticket": { "name": "jira_get_issue", "args": { "issue_key": { "arg": "key" } } },
 *     "search_tickets": { "name": "jira_search", "args": {
 *       "jql": { "template": "text ~ \"{query}\" ORDER BY updated DESC" }, "limit": { "value": 10 } } } } }
 * ```
 *
 * Argument specs:
 * - `{ "arg": "<localArg>" }`: the value of a local argument under the remote name (rename).
 * - `{ "value": <string | number | boolean> }`: a fixed literal.
 * - `{ "template": "...{localArg}..." }`: a string; each substituted value has `\` and `"` escaped,
 *   so it stays inside a quoted string of a query language (JQL and similar).
 *
 * A tool left out of the file (or the whole file absent) keeps the `MCP_TOOL_*` name and passes the
 * local arguments unchanged. The committed `config/mcp-tools.example.json` shows the shape.
 */
const ArgSpecSchema = z.union([
  z.strictObject({ arg: z.string().min(1) }),
  z.strictObject({ value: z.union([z.string(), z.number(), z.boolean()]) }),
  z.strictObject({ template: z.string() }),
]);

const ToolMappingSchema = z.strictObject({
  name: z.string().min(1),
  args: z.record(z.string().min(1), ArgSpecSchema).optional(),
});

const McpToolsConfigSchema = z.strictObject({
  tools: z.partialRecord(z.enum(Object.keys(toolArgSchemas) as [ToolName, ...ToolName[]]), ToolMappingSchema),
});

export type ArgSpec = z.infer<typeof ArgSpecSchema>;
/** Remote tool for one local tool; without `args` the local arguments pass through unchanged. */
export type ToolMapping = z.infer<typeof ToolMappingSchema>;
export type McpToolsConfig = z.infer<typeof McpToolsConfigSchema>;

const PLACEHOLDER = /\{(\w+)\}/g;
const EXAMPLE = "config/mcp-tools.example.json";
export const DEFAULT_CALL_TIMEOUT_MS = 20_000;

/** Local argument names a spec reads (for validation against the tool's argument schema). */
function referencedArgs(spec: ArgSpec): string[] {
  if ("arg" in spec) return [spec.arg];
  if ("template" in spec) return [...spec.template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
  return [];
}

export function parseMcpToolsConfig(raw: unknown, origin = "MCP tools config"): McpToolsConfig {
  const parsed = McpToolsConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${origin} is invalid (see ${EXAMPLE}):\n${z.prettifyError(parsed.error)}`);
  for (const [tool, mapping] of Object.entries(parsed.data.tools) as [ToolName, ToolMapping][]) {
    const known = Object.keys(toolArgSchemas[tool].shape);
    for (const [remoteArg, spec] of Object.entries(mapping.args ?? {})) {
      const unknown = referencedArgs(spec).find((name) => !known.includes(name));
      if (unknown) {
        throw new Error(`${origin}: ${tool}.args.${remoteArg} refers to "${unknown}", which is not an argument of ${tool} (${known.join(", ")}).`);
      }
    }
  }
  return parsed.data;
}

/** Reads the mapping file; `undefined` when it does not exist (env names + identity arguments). */
export async function loadMcpToolsConfig(path: string): Promise<McpToolsConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`MCP tools config at ${path} is not valid JSON.`);
  }
  return parseMcpToolsConfig(raw, `MCP tools config at ${path}`);
}

/** File mappings win; every other tool keeps its `MCP_TOOL_*` name with identity arguments. */
export function resolveToolMappings(envNames: Record<ToolName, string>, file: McpToolsConfig | undefined): Record<ToolName, ToolMapping> {
  const entries = (Object.keys(envNames) as ToolName[]).map((tool) => [tool, file?.tools[tool] ?? { name: envNames[tool] }] as const);
  return Object.fromEntries(entries) as Record<ToolName, ToolMapping>;
}

const escapeQuoted = (value: string): string => value.replace(/[\\"]/g, (char) => `\\${char}`);

/** Builds the remote arguments for one call from the local (already validated) arguments. */
export function mapToolArgs(mapping: ToolMapping, args: Record<string, unknown>): Record<string, unknown> {
  if (!mapping.args) return { ...args };
  const remote: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(mapping.args)) {
    if ("value" in spec) remote[name] = spec.value;
    else if ("arg" in spec) {
      if (args[spec.arg] !== undefined) remote[name] = args[spec.arg];
    } else remote[name] = spec.template.replace(PLACEHOLDER, (_, arg: string) => escapeQuoted(String(args[arg] ?? "")));
  }
  return remote;
}

/** Per-call timeout for MCP tools (`MCP_CALL_TIMEOUT_MS`, default 20000). */
export function resolveCallTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CALL_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`MCP_CALL_TIMEOUT_MS must be a positive integer (milliseconds), got "${raw}".`);
  return value;
}
