import { describe, expect, it } from "vitest";
import { parseEvalArgs, selectCases } from "../evals/options.js";

describe("eval options", () => {
  it("defaults to every case, one run, full eval", () => {
    expect(parseEvalArgs([])).toEqual({ retrievalOnly: false, only: undefined, repeat: 1 });
  });

  it("reads --retrieval-only, --only and --repeat (space or = form)", () => {
    expect(parseEvalArgs(["--only", "a,b", "--repeat", "5"])).toEqual({ retrievalOnly: false, only: ["a", "b"], repeat: 5 });
    expect(parseEvalArgs(["--retrieval-only", "--only=a, b ,", "--repeat=2"])).toEqual({ retrievalOnly: true, only: ["a", "b"], repeat: 2 });
  });

  it("rejects an invalid repeat count, an empty --only and unknown flags", () => {
    for (const bad of ["0", "-1", "1.5", "x", ""]) expect(() => parseEvalArgs(["--repeat", bad])).toThrow(/--repeat/);
    expect(() => parseEvalArgs(["--repeat"])).toThrow(/--repeat/);
    expect(() => parseEvalArgs(["--only"])).toThrow(/--only/);
    expect(() => parseEvalArgs(["--only", ","])).toThrow(/--only/);
    expect(() => parseEvalArgs(["--repaet", "3"])).toThrow(/Unknown option "--repaet"/);
  });

  it("selects cases in file order and lists the valid ids for an unknown one", () => {
    const cases = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(selectCases(cases, undefined)).toBe(cases);
    expect(selectCases(cases, ["c", "a", "c"]).map((c) => c.id)).toEqual(["a", "c"]);
    expect(() => selectCases(cases, ["a", "zz"])).toThrow('Unknown eval case id(s): zz. Valid ids: a, b, c');
  });
});
