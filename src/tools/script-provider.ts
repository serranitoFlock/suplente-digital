import { spawn, type ChildProcess } from "node:child_process";
import type { RegisteredScript, ScriptRegistry } from "./scripts.js";
import { SCRIPT_TOOL, ToolCallError, ToolNotAllowedError, type ToolCall, type ToolFailureKind, type ToolProvider } from "./types.js";

/** Output kept from a script (bytes of stdout); the rest is dropped and the reply says it was truncated. */
export const DEFAULT_MAX_OUTPUT_BYTES = 20_000;
export const OUTPUT_TRUNCATED_MARKER = "\n[... salida truncada ...]";

/** The only variables a script gets besides the ones its entry declares in `env`. */
const BASE_ENV = ["PATH", "HOME", "LANG"] as const;

export interface RunScriptOptions {
  maxOutputBytes?: number;
}

/** Minimal environment: `PATH`, `HOME`, `LANG` and the declared names, copied from `source` when set. */
export function scriptEnv(declared: readonly string[], source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV, ...declared]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Kills the script and everything it started (its own process group), so pipes close and nothing lingers. */
function killTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * Runs a registered script with `spawn` and `shell: false` (the primitive `execFile` wraps; never a shell):
 * `argv` is passed as a list, so values are single arguments that nothing re-parses. `spawn` rather than
 * `execFile` because only it can start the script in its own process group, so a timeout or the output cap
 * kills everything the script started. Bounded by the entry's `timeoutMs` and by `maxOutputBytes`.
 * A non-zero exit, a timeout or a spawn error becomes `ToolCallError`; stderr is discarded, never returned or logged.
 */
export function runScript(script: RegisteredScript, argv: string[], { maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }: RunScriptOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const fail = (kind: ToolFailureKind, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ToolCallError(SCRIPT_TOOL, kind, message));
    };

    let child: ChildProcess;
    try {
      child = spawn(script.commandPath, argv, {
        cwd: script.cwdPath,
        env: scriptEnv(script.env),
        shell: false,
        // Own process group (Unix) so the whole tree can be killed.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return reject(new ToolCallError(SCRIPT_TOOL, "unavailable", `Script "${script.id}" could not start.`));
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, script.timeoutMs);

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = maxOutputBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        truncated = true;
        killTree(child);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr!.resume();

    child.on("error", () => fail("unavailable", `Script "${script.id}" could not start.`));
    child.on("close", (code) => {
      if (timedOut) return fail("timeout", `Script "${script.id}" timed out after ${script.timeoutMs} ms.`);
      if (!truncated && code !== 0) return fail("script_error", `Script "${script.id}" exited with status ${code ?? "signal"}.`);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // `stream: true` drops a multi-byte character cut in half by the cap.
      const text = new TextDecoder().decode(Buffer.concat(chunks), { stream: true });
      resolvePromise(truncated ? `${text}${OUTPUT_TRUNCATED_MARKER}` : text);
    });
  });
}

export interface ScriptProviderOptions extends RunScriptOptions {
  /** Executes a validated script call (tests plug in a spy); default `runScript`. */
  execute?: (script: RegisteredScript, argv: string[], options: RunScriptOptions) => Promise<string>;
}

/**
 * Serves `run_script` from the registry and sends every other tool to the wrapped provider (mock or MCP).
 * The call is re-validated here (defense in depth): an unknown id or invalid args never execute.
 */
export class ScriptToolProvider implements ToolProvider {
  readonly name: string;
  #registry: ScriptRegistry;

  constructor(
    private readonly base: ToolProvider,
    registry: ScriptRegistry,
    private readonly options: ScriptProviderOptions = {},
  ) {
    this.name = base.name;
    this.#registry = registry;
  }

  get scripts(): ScriptRegistry {
    return this.#registry;
  }

  /** Replaces the registry (admin panel change); calls that already resolved their script keep it. */
  reload(registry: ScriptRegistry): void {
    this.#registry = registry;
  }

  async call(call: ToolCall): Promise<string> {
    if (call.tool !== SCRIPT_TOOL) return this.base.call(call);
    const registry = this.#registry;
    const resolved = registry.resolve(call.args);
    const script = resolved && registry.get(resolved.script);
    if (!resolved || !script) {
      throw new ToolNotAllowedError(`${SCRIPT_TOOL} ${JSON.stringify(call.args.script)}`, "is not a registered read-only script or its arguments are invalid");
    }
    const execute = this.options.execute ?? runScript;
    return execute(script, registry.argv(script, resolved.args as Record<string, string | number>), { maxOutputBytes: this.options.maxOutputBytes });
  }

  async close(): Promise<void> {
    await this.base.close?.();
  }
}

/** Adds `run_script` to a provider only when at least one script is registered. */
export function withScripts(base: ToolProvider, registry: ScriptRegistry, options: ScriptProviderOptions = {}): ToolProvider {
  return registry.size > 0 ? new ScriptToolProvider(base, registry, options) : base;
}

/**
 * Always serves `run_script` from a registry that can be replaced later (`reload`), even while it is empty: an empty
 * registry offers no script to the model and refuses every `run_script` call.
 */
export function withReloadableScripts(base: ToolProvider, registry: ScriptRegistry, options: ScriptProviderOptions = {}): ScriptToolProvider {
  return new ScriptToolProvider(base, registry, options);
}
