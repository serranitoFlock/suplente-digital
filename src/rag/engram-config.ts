import { readFile } from "node:fs/promises";
import { DEFAULT_ENGRAM_TYPES } from "./engram.js";

/**
 * Local, gitignored allowlist of Engram projects (`config/engram-sources.local.json`).
 * The committed `config/engram-sources.example.json` shows the shape with fictional names.
 */
export interface EngramSourcesConfig {
  projects: string[];
  types: string[];
}

/** Project names double as file names and CLI arguments: no paths, spaces or leading dashes. */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Types that never describe durable project knowledge, even if someone adds them to the config. */
const NEVER_INDEXED_TYPES = new Set(["session_summary", "passive"]);
const EXAMPLE = "config/engram-sources.example.json";

export function parseEngramSourcesConfig(raw: unknown, origin = "Engram sources config"): EngramSourcesConfig {
  const value = (raw ?? {}) as { projects?: unknown; types?: unknown };
  if (!Array.isArray(value.projects) || value.projects.length === 0) {
    throw new Error(`${origin}: "projects" must be a non-empty list of Engram project names (see ${EXAMPLE}).`);
  }
  const projects = value.projects.map((p) => {
    if (typeof p !== "string" || !PROJECT_NAME.test(p) || p.includes("..")) throw new Error(`${origin}: invalid project name ${JSON.stringify(p)}.`);
    return p;
  });
  const duplicate = projects.find((p, i) => projects.indexOf(p) !== i);
  if (duplicate) throw new Error(`${origin}: duplicate project "${duplicate}".`);

  let types: string[] = [...DEFAULT_ENGRAM_TYPES];
  if (value.types !== undefined) {
    if (!Array.isArray(value.types) || value.types.length === 0 || value.types.some((t) => typeof t !== "string" || !t.trim())) {
      throw new Error(`${origin}: "types" must be a non-empty list of observation types.`);
    }
    types = value.types as string[];
    const forbidden = types.find((t) => NEVER_INDEXED_TYPES.has(t));
    if (forbidden) throw new Error(`${origin}: type "${forbidden}" is never indexed (session notes and passive captures are not knowledge).`);
  }
  return { projects, types };
}

export async function loadEngramSourcesConfig(path: string): Promise<EngramSourcesConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Engram sources config not found at ${path}. Copy ${EXAMPLE} to config/engram-sources.local.json and list the projects to include.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Engram sources config at ${path} is not valid JSON.`);
  }
  return parseEngramSourcesConfig(raw, path);
}

/** Parses a boolean environment flag (`true/false`, `1/0`, `yes/no`, `sí/no`). */
export function resolveFlag(name: string, raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (["true", "1", "yes", "si", "sí"].includes(value)) return true;
  if (["false", "0", "no"].includes(value)) return false;
  throw new Error(`${name} must be true or false, got "${raw}".`);
}
