import type { ApiTokens } from "./auth.js";

export const MIN_TOKEN_LENGTH = 24;
export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 8787;

export interface ApiServerConfig {
  host: string;
  port: number;
  tokens: ApiTokens;
}

type Env = Record<string, string | undefined>;

/**
 * Reads the HTTP API settings: `ASSISTANT_API_HOST` (default 127.0.0.1), `ASSISTANT_API_PORT` (default 8787),
 * `ASSISTANT_API_TOKEN` (client scope) and `ASSISTANT_ADMIN_TOKEN` (admin scope). Throws one message listing every
 * problem; token values are never echoed.
 */
export function resolveApiConfig(env: Env): ApiServerConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  const problems: string[] = [];

  const rawPort = value("ASSISTANT_API_PORT");
  const port = rawPort === undefined ? DEFAULT_API_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`ASSISTANT_API_PORT must be an integer between 1 and 65535, got "${rawPort}".`);

  const token = (name: string): string => {
    const raw = value(name);
    if (raw === undefined) problems.push(`${name} is missing: set a random secret of at least ${MIN_TOKEN_LENGTH} characters (e.g. \`openssl rand -hex 32\`).`);
    else if (raw.length < MIN_TOKEN_LENGTH) problems.push(`${name} must be at least ${MIN_TOKEN_LENGTH} characters long.`);
    return raw ?? "";
  };
  const client = token("ASSISTANT_API_TOKEN");
  const admin = token("ASSISTANT_ADMIN_TOKEN");
  if (client && client === admin) problems.push("ASSISTANT_API_TOKEN and ASSISTANT_ADMIN_TOKEN must be different.");

  if (problems.length > 0) throw new Error(`Invalid HTTP API configuration:\n- ${problems.join("\n- ")}`);
  return { host: value("ASSISTANT_API_HOST") ?? DEFAULT_API_HOST, port, tokens: { client, admin } };
}
