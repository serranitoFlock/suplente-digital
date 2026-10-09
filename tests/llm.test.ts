import { describe, expect, it } from "vitest";
import { describeLlmError, extractJson, resolveLlmSettings, stripThinking } from "../src/llm.js";

describe("resolveLlmSettings", () => {
  it("defaults to the openai-compatible provider with local Ollama settings", () => {
    expect(resolveLlmSettings({ LLM_MODEL: "qwen3:8b" })).toEqual({
      provider: "openai-compatible",
      model: "qwen3:8b",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "not-needed",
      temperature: 0.5,
      disableThinking: true,
    });
  });

  it("reads explicit openai-compatible overrides", () => {
    const settings = resolveLlmSettings({
      LLM_PROVIDER: "openai-compatible",
      LLM_MODEL: "bonsai-27b",
      LLM_BASE_URL: "http://localhost:8080/v1",
      LLM_API_KEY: "secret",
      LLM_TEMPERATURE: "0.2",
      LLM_DISABLE_THINKING: "false",
    });
    expect(settings).toMatchObject({
      baseUrl: "http://localhost:8080/v1",
      apiKey: "secret",
      temperature: 0.2,
      disableThinking: false,
    });
  });

  it("fails with a clear message when LLM_MODEL is missing", () => {
    expect(() => resolveLlmSettings({})).toThrow(/LLM_MODEL/);
    expect(() => resolveLlmSettings({ LLM_MODEL: "   " })).toThrow(/LLM_MODEL/);
  });

  it("rejects an invalid temperature and unknown providers", () => {
    expect(() => resolveLlmSettings({ LLM_MODEL: "m", LLM_TEMPERATURE: "hot" })).toThrow(/LLM_TEMPERATURE/);
    expect(() => resolveLlmSettings({ LLM_PROVIDER: "gemini", LLM_MODEL: "m" })).toThrow(/LLM_PROVIDER/);
  });

  it("selects Anthropic only when requested and requires its API key", () => {
    expect(resolveLlmSettings({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(resolveLlmSettings({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-x" }).model).toBe("claude-x");
    expect(() => resolveLlmSettings({ LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("stripThinking", () => {
  it("removes complete think blocks", () => {
    expect(stripThinking("<think>\nrazono {a}\n</think>\n\nRespuesta final")).toBe("Respuesta final");
    expect(stripThinking("Hola <THINK>x</THINK>mundo")).toBe("Hola mundo");
  });

  it("drops reasoning whose opening tag was part of the prompt template", () => {
    expect(stripThinking("pienso un rato...</think>Respuesta")).toBe("Respuesta");
  });

  it("drops an unterminated (truncated) think block", () => {
    expect(stripThinking("Respuesta<think>me cortaron")).toBe("Respuesta");
  });

  it("leaves plain text untouched apart from trimming", () => {
    expect(stripThinking("  sin razonamiento  ")).toBe("sin razonamiento");
  });
});

describe("extractJson", () => {
  it("parses a fenced json block surrounded by prose", () => {
    expect(extractJson('Claro, acá va:\n```json\n{"tool":"get_ticket","args":{"key":"DEMO-101"}}\n```\nSaludos {no json}')).toEqual({
      tool: "get_ticket",
      args: { key: "DEMO-101" },
    });
  });

  it("ignores braces in trailing prose", () => {
    expect(extractJson('{"route":"task","topic":"jira","reason":"usa {llaves}"} Nota: {esto no}')).toEqual({
      route: "task",
      topic: "jira",
      reason: "usa {llaves}",
    });
  });

  it("skips think blocks that contain braces", () => {
    expect(extractJson('<think>quizá {"route":"sensitive"}</think>{"route":"question"}')).toEqual({ route: "question" });
  });

  it("skips non-JSON brace groups before the real object", () => {
    expect(extractJson('Uso {placeholder} y luego {"tool":"none"}')).toEqual({ tool: "none" });
  });

  it("returns undefined when there is no JSON object", () => {
    for (const bad of ["no json here", "{broken", "[1,2]"]) expect(extractJson(bad)).toBeUndefined();
  });
});

describe("describeLlmError", () => {
  const settings = resolveLlmSettings({ LLM_MODEL: "qwen3:8b" });

  it("explains an unreachable local server", () => {
    const error = Object.assign(new Error("Connection error."), { name: "APIConnectionError" });
    const message = describeLlmError(error, settings);
    expect(message).toMatch(/http:\/\/localhost:11434\/v1/);
    expect(message).toMatch(/ollama serve/);
  });

  it("explains a model that is not available on the server", () => {
    const error = Object.assign(new Error('404 model "qwen3:8b" not found, try pulling it first'), { status: 404 });
    expect(describeLlmError(error, settings)).toMatch(/ollama pull qwen3:8b/);
  });

  it("passes other errors through", () => {
    expect(describeLlmError(new Error("boom"), settings)).toBe("boom");
  });
});
