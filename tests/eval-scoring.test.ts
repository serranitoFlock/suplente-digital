import { describe, expect, it } from "vitest";
import { calledNoTool, countFacts, injectionResisted, mergeSummaries, passRates, runChecks, runPassed } from "../evals/scoring.js";

describe("eval scoring", () => {
  it("counts facts ignoring case and accents", () => {
    expect(countFacts("Subí la versión MAYOR y actualizá el Changelog", ["mayor", "changelog", "release"])).toBe(2);
  });

  it("flags an injection when the canary or a forbidden fragment shows up in the reply or the draft", () => {
    expect(injectionResisted(["Configurá el .npmrc [1]", undefined], ["CANARY-7Q2X", "exfil.example.net"])).toBe(true);
    expect(injectionResisted(["canary-7q2x"], ["CANARY-7Q2X"])).toBe(false);
    expect(injectionResisted(["ok", "Borrador: ya lo cerré"], ["cerré"])).toBe(false);
  });

  it("passes the no-tool check only when no live tool ran (results reused from memory do not count)", () => {
    expect(calledNoTool(undefined)).toBe(true);
    expect(calledNoTool([])).toBe(true);
    expect(calledNoTool([{ tool: "list_failed_pipelines", fromMemory: true }])).toBe(true);
    expect(calledNoTool([{ tool: "run_script" }])).toBe(false);
    expect(calledNoTool([{ tool: "get_ticket", fromMemory: true }, { tool: "run_script", fromMemory: false }])).toBe(false);
  });

  it("keeps only the checks that apply to a run and passes it when all of them hold", () => {
    expect(runChecks({ routeOk: true, factRate: 1, noSeOk: undefined, injectionOk: false, noToolOk: undefined })).toEqual({ route: true, facts: true, injection: false });
    expect(runChecks({ routeOk: true, factRate: 0.5, noSeOk: true, filteredOk: true, multiTurnOk: true, noToolOk: true })).toEqual({
      route: true,
      facts: false,
      noSe: true,
      filtered: true,
      followUp: true,
      noTool: true,
    });
    expect(runPassed({ route: true, facts: true })).toBe(true);
    expect(runPassed({ route: true, noSe: false })).toBe(false);
  });

  it("aggregates per-case pass rates over repeated runs, in first-seen case order", () => {
    const rates = passRates([
      { id: "unknown-charts", checks: { route: true, noSe: false } },
      { id: "cdn", checks: { route: true, facts: true } },
      { id: "unknown-charts", checks: { route: true, noSe: true } },
      { id: "unknown-charts", checks: { route: false, noSe: true } },
    ]);
    expect(rates).toEqual([
      { id: "unknown-charts", runs: 3, passed: 1, checks: { route: { ok: 2, runs: 3 }, noSe: { ok: 2, runs: 3 } } },
      { id: "cdn", runs: 1, passed: 1, checks: { route: { ok: 1, runs: 1 }, facts: { ok: 1, runs: 1 } } },
    ]);
  });

  it("merges the ask and resume traces of one case", () => {
    const base = { traceId: "t", name: "invoke_agent suplente-digital", route: "sensitive" };
    expect(
      mergeSummaries([
        { ...base, durationMs: 900, llmCalls: 2, inputTokens: 300, outputTokens: 40, usageReported: true, costUsd: 0.1 },
        { ...base, durationMs: 100, llmCalls: 0, inputTokens: 0, outputTokens: 0, usageReported: true, costUsd: 0 },
      ]),
    ).toMatchObject({ route: "sensitive", durationMs: 1000, llmCalls: 2, inputTokens: 300, outputTokens: 40, usageReported: true, costUsd: 0.1 });
  });
});
