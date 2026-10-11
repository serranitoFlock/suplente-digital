import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { guardScript } from "./script-guard.js";
import type { ScriptCatalog, ScriptToolArgs } from "./types.js";

/**
 * Registry of human-registered read-only query scripts (`SCRIPTS_CONFIG`, default
 * `config/scripts.local.json`, gitignored; `config/scripts.example.json` shows the shape):
 *
 * ```json
 * { "scripts": [{
 *     "id": "failed-jobs",
 *     "description": "Lista los jobs de CI fallidos en los últimos N días.",
 *     "command": "scripts/demo/failed-jobs.sh",
 *     "argv": ["--days", "{days}"],
 *     "params": { "days": { "type": "int", "min": 1, "max": 30, "default": 7 } },
 *     "readOnly": true, "timeoutMs": 10000, "env": ["CI_READ_TOKEN"] }] }
 * ```
 *
 * Deny by default: an entry is registered only if it is valid, declares `readOnly: true` (literally) and
 * the static write guard finds nothing. Any other entry is skipped with a warning and never reaches the model.
 * The model never decides whether a script is read-only; the human who registers it does.
 *
 * - `command`: an executable path relative to the repo root, or a bare program name looked up in `PATH`.
 *   Shells and inline code (`sh -c`, `node -e`, ...) are refused: register a script file instead.
 * - `argv`: literal strings; `{param}` inserts a validated parameter value inside one argument.
 *   Arguments are passed to `execFile` as a list: no shell ever parses them.
 * - `params`: `int` (min/max), `enum` (values) or `string` (a required full-match regex `pattern` and
 *   `maxLength`; never starting with `-`), each with an optional `default` and `description`.
 * - `env`: names of variables copied from the bot's environment (e.g. a read-only token); nothing else is passed
 *   besides `PATH`, `HOME` and `LANG`. `cwd`: working directory relative to the repo root (default: the root).
 */

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PARAM_NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;
const EXAMPLE = "config/scripts.example.json";

export const DEFAULT_SCRIPT_TIMEOUT_MS = 15_000;
export const MAX_SCRIPT_TIMEOUT_MS = 120_000;

/** Programs that run other code or commands from their arguments: a placeholder there would be code injection. */
const COMMAND_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "env", "xargs", "eval", "exec", "sudo", "doas", "su", "nohup", "timeout", "watch", "busybox"]);
const INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "ruby", "perl", "php", "lua", "pwsh", "powershell", "osascript"]);
const INLINE_CODE_FLAG = /^-(?:[a-zA-Z]*[ceEpr]|-eval|-print|-command|-exec)(?:=.*)?$/;

const description = z.string().max(200).optional();
const ParamSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("int"), min: z.number().int(), max: z.number().int(), default: z.number().int().optional(), description }),
  z.strictObject({ type: z.literal("enum"), values: z.array(z.string().min(1).max(100)).min(1).max(50), default: z.string().optional(), description }),
  z.strictObject({ type: z.literal("string"), pattern: z.string().min(1).max(200), maxLength: z.number().int().min(1).max(500), default: z.string().optional(), description }),
]);

const ScriptEntrySchema = z.strictObject({
  id: z.string().regex(ID, "a lowercase slug (letters, digits and dashes)"),
  description: z.string().min(1).max(500),
  command: z.string().min(1).max(300),
  argv: z.array(z.string().max(500)).max(50).default([]),
  params: z.record(z.string().regex(PARAM_NAME, "a parameter name like sinceDays"), ParamSchema).default({}),
  readOnly: z.literal(true),
  timeoutMs: z.number().int().min(100).max(MAX_SCRIPT_TIMEOUT_MS).default(DEFAULT_SCRIPT_TIMEOUT_MS),
  env: z.array(z.string().regex(ENV_NAME, "an environment variable name like CI_READ_TOKEN")).max(20).default([]),
  cwd: z.string().min(1).optional(),
});

const RegistryFileSchema = z.strictObject({ scripts: z.array(z.unknown()) });

export type ScriptParam = z.infer<typeof ParamSchema>;
export type ScriptEntry = z.infer<typeof ScriptEntrySchema>;
export type ScriptArgValues = Record<string, string | number>;

/** A registered (validated, read-only, guard-clean) script, ready to run. */
export interface RegisteredScript extends ScriptEntry {
  /** Absolute executable path, or the bare program name (looked up in `PATH`). */
  commandPath: string;
  /** Absolute working directory. */
  cwdPath: string;
  argsSchema: z.ZodType<ScriptArgValues>;
}

export interface RejectedScript {
  /** Script id, or `entry #N` when the id itself is missing or invalid. */
  id: string;
  reason: string;
}

class EntryError extends Error {}

const insideRoot = (root: string, path: string) => {
  const rel = relative(root, path);
  return !(rel.split(sep)[0] === ".." || isAbsolute(rel));
};

/** Builds the zod schema of one param, or throws when the declaration is inconsistent. */
function paramSchema(name: string, param: ScriptParam): z.ZodType {
  let schema: z.ZodType;
  if (param.type === "int") {
    if (param.min > param.max) throw new EntryError(`param "${name}": min is greater than max`);
    const int = z.number().int().min(param.min).max(param.max);
    // Models sometimes send numbers as strings ("7"); only plain integers are converted.
    schema = z.preprocess((value) => (typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value), int);
  } else if (param.type === "enum") {
    schema = z.enum(param.values as [string, ...string[]]);
  } else {
    let pattern: RegExp;
    try {
      pattern = new RegExp(`^(?:${param.pattern})$`, "u");
    } catch {
      throw new EntryError(`param "${name}": pattern is not a valid regular expression`);
    }
    schema = z
      .string()
      .max(param.maxLength)
      .regex(pattern)
      .refine((value) => !value.startsWith("-") && !value.includes("\0"), "must not start with '-' or contain NUL");
  }
  if (param.default === undefined) return schema;
  if (!schema.safeParse(param.default).success) throw new EntryError(`param "${name}": default ${JSON.stringify(param.default)} is not a valid value`);
  return schema.default(param.default as never);
}

/** Validates one raw entry; throws `EntryError` (or returns a reason) when it must not be registered. */
async function registerEntry(raw: unknown, root: string, realRoot: string): Promise<RegisteredScript> {
  // Deny by default: only a literal `true` declared by a human counts.
  if ((raw as { readOnly?: unknown } | null)?.readOnly !== true) throw new EntryError("readOnly must be literally true");
  const parsed = ScriptEntrySchema.safeParse(raw);
  if (!parsed.success) throw new EntryError(`invalid entry (see ${EXAMPLE}):\n${z.prettifyError(parsed.error)}`);
  const entry = parsed.data;

  const shape = Object.fromEntries(Object.entries(entry.params).map(([name, param]) => [name, paramSchema(name, param)]));
  for (const token of entry.argv) {
    for (const [, name] of token.matchAll(PLACEHOLDER)) {
      if (!Object.hasOwn(entry.params, name!)) throw new EntryError(`argv uses {${name}}, which is not a declared param`);
    }
  }

  let commandPath: string;
  if (isAbsolute(entry.command)) throw new EntryError("command must be relative to the repo root or a bare program name");
  if (/[/\\]/.test(entry.command)) {
    commandPath = resolve(root, entry.command);
    const real = await realpath(commandPath).catch(() => undefined);
    if (!real || !insideRoot(realRoot, real)) throw new EntryError(`command ${entry.command} does not exist inside the repo`);
    if (!(await stat(real)).isFile()) throw new EntryError(`command ${entry.command} is not a file`);
    await access(real, constants.X_OK).catch(() => {
      throw new EntryError(`command ${entry.command} is not executable (chmod +x)`);
    });
  } else {
    if (!BARE_COMMAND.test(entry.command)) throw new EntryError("command is not a valid program name");
    commandPath = entry.command;
  }
  const program = basename(entry.command);
  if (COMMAND_RUNNERS.has(program)) throw new EntryError(`command ${program} runs other commands; register the script file itself`);
  if (INTERPRETERS.has(program) && entry.argv.some((token) => INLINE_CODE_FLAG.test(token))) {
    throw new EntryError(`command ${program} with inline code is not allowed; register a script file instead`);
  }

  const cwdPath = resolve(root, entry.cwd ?? ".");
  if (entry.cwd !== undefined) {
    const real = await realpath(cwdPath).catch(() => undefined);
    if (isAbsolute(entry.cwd) || !real || !insideRoot(realRoot, real) || !(await stat(real)).isDirectory()) {
      throw new EntryError(`cwd ${entry.cwd} is not a directory inside the repo`);
    }
  }

  const enumValues = Object.fromEntries(Object.entries(entry.params).flatMap(([name, p]) => (p.type === "enum" ? [[name, p.values]] : [])));
  const findings = await guardScript({ command: entry.command, argv: entry.argv, enumValues, cwd: cwdPath }, root);
  if (findings.length > 0) {
    const detail = findings.map((f) => `${f.family} (${JSON.stringify(f.match.slice(0, 60))} in ${f.source})`).join(", ");
    throw new EntryError(`the static write guard flagged ${detail}`);
  }

  return { ...entry, commandPath, cwdPath, argsSchema: z.strictObject(shape) as unknown as z.ZodType<ScriptArgValues> };
}

const describeParam = (name: string, param: ScriptParam): string => {
  const kind =
    param.type === "int"
      ? `entero de ${param.min} a ${param.max}`
      : param.type === "enum"
        ? `uno de: ${param.values.join(", ")}`
        : `texto que cumple /${param.pattern}/, máximo ${param.maxLength} caracteres`;
  const fallback = param.default === undefined ? "obligatorio" : `por defecto ${param.default}`;
  return `${name} (${param.description ? `${param.description}; ` : ""}${kind}; ${fallback})`;
};

export class ScriptRegistry implements ScriptCatalog {
  readonly #scripts: Map<string, RegisteredScript>;

  constructor(
    scripts: RegisteredScript[],
    readonly rejected: readonly RejectedScript[] = [],
  ) {
    this.#scripts = new Map(scripts.map((script) => [script.id, script]));
  }

  get size(): number {
    return this.#scripts.size;
  }

  ids(): string[] {
    return [...this.#scripts.keys()];
  }

  get(id: string): RegisteredScript | undefined {
    return this.#scripts.get(id);
  }

  describe(): string[] {
    return [...this.#scripts.values()].map((script) => {
      const params = Object.entries(script.params).map(([name, param]) => describeParam(name, param));
      return `${script.id}: ${script.description} Parámetros: ${params.length ? params.join("; ") : "ninguno"}.`;
    });
  }

  resolve({ script, args }: ScriptToolArgs): ScriptToolArgs | null {
    const entry = this.#scripts.get(script);
    const parsed = entry?.argsSchema.safeParse(args);
    return parsed?.success ? { script, args: parsed.data } : null;
  }

  /** The argument list for `execFile`: literals as declared, `{param}` replaced by validated values. */
  argv(script: RegisteredScript, values: ScriptArgValues): string[] {
    return script.argv.map((token) => token.replace(PLACEHOLDER, (_, name: string) => String(values[name])));
  }
}

export interface RegistryOptions {
  /** Receives one message per skipped entry (default: `console.warn`, i.e. stderr). */
  warn?: (message: string) => void;
}

/** Validates every entry and keeps only the read-only, guard-clean ones; the rest are skipped with a warning. */
export async function buildScriptRegistry(raw: unknown, root: string, { warn = console.warn }: RegistryOptions = {}, origin = "Script registry"): Promise<ScriptRegistry> {
  const file = RegistryFileSchema.safeParse(raw);
  if (!file.success) throw new Error(`${origin} is invalid (see ${EXAMPLE}):\n${z.prettifyError(file.error)}`);
  const realRoot = await realpath(root);
  const registered: RegisteredScript[] = [];
  const rejected: RejectedScript[] = [];
  for (const [index, entry] of file.data.scripts.entries()) {
    const rawId = (entry as { id?: unknown } | null)?.id;
    const id = typeof rawId === "string" && ID.test(rawId) ? rawId : `entry #${index + 1}`;
    try {
      if (registered.some((script) => script.id === id)) throw new EntryError("duplicate id (the first entry wins)");
      registered.push(await registerEntry(entry, root, realRoot));
    } catch (error) {
      if (!(error instanceof EntryError)) throw error;
      rejected.push({ id, reason: error.message });
      warn(`[scripts] Skipped ${id.startsWith("entry #") ? id : `"${id}"`}: ${error.message}. It is not offered to the model.`);
    }
  }
  return new ScriptRegistry(registered, rejected);
}

/** Reads the registry file; an absent file means no scripts (and no `run_script` tool). */
export async function loadScriptRegistry(path: string, root: string, options: RegistryOptions = {}): Promise<ScriptRegistry> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ScriptRegistry([]);
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Script registry at ${path} is not valid JSON.`);
  }
  return buildScriptRegistry(raw, root, options, `Script registry at ${path}`);
}
