/**
 * Command-line options of `npm run eval` (`evals/run.ts`), unit-tested in tests/eval-options.test.ts.
 *
 *   npm run eval                                  every case, once
 *   npm run eval -- --retrieval-only              retriever metrics only (no LLM)
 *   npm run eval -- --only a,b                    only these case ids (file order; unknown ids fail fast)
 *   npm run eval -- --only a,b --repeat 5         each selected case 5 times, with per-case pass rates
 *
 * `--only` also narrows the retrieval metrics to the selected cases (they run once, since ranking is
 * deterministic). `--repeat N` (integer >= 1, default 1) runs every selected case N independent times
 * (fresh thread ids, setup turns replayed); for N > 1 a per-case pass-rate table follows the per-run table,
 * and the aggregate metrics, latency and tokens cover all runs.
 */
export interface EvalOptions {
  retrievalOnly: boolean;
  only: string[] | undefined;
  repeat: number;
}

export function parseEvalArgs(argv: string[]): EvalOptions {
  const options: EvalOptions = { retrievalOnly: false, only: undefined, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      const next = inline ?? argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--retrieval-only" && inline === undefined) {
      options.retrievalOnly = true;
    } else if (flag === "--only") {
      const ids = value().split(",").map((id) => id.trim()).filter(Boolean);
      if (!ids.length) throw new Error("--only needs at least one case id (e.g. --only wc-create,lib-semver).");
      options.only = ids;
    } else if (flag === "--repeat") {
      const raw = value();
      const repeat = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(repeat) || repeat < 1) throw new Error(`--repeat must be an integer >= 1 (got "${raw}").`);
      options.repeat = repeat;
    } else {
      throw new Error(`Unknown option "${arg}". Valid: --retrieval-only, --only <id,...>, --repeat <N>.`);
    }
  }
  return options;
}

/** Keeps the cases named by `--only`, in file order; an unknown id fails before any model is loaded. */
export function selectCases<T extends { id: string }>(cases: T[], only: string[] | undefined): T[] {
  if (!only) return cases;
  const known = new Set(cases.map((c) => c.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown eval case id(s): ${unknown.join(", ")}. Valid ids: ${cases.map((c) => c.id).join(", ")}`);
  const wanted = new Set(only);
  return cases.filter((c) => wanted.has(c.id));
}
