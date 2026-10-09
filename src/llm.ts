import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { withSpan, type Attributes } from "./observability/tracing.js";

/** Minimal text-in/text-out contract so graph nodes can be tested with a fake model. */
export type Llm = (system: string, user: string) => Promise<string>;

export type LlmSettings =
  | { provider: "anthropic"; model: string }
  | {
      provider: "openai-compatible";
      model: string;
      baseUrl: string;
      apiKey: string;
      temperature: number;
      disableThinking: boolean;
    };

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
/** Bonsai's recommended sampling temperature; also a sensible default for small local models. */
const DEFAULT_TEMPERATURE = 0.5;

/** Resolves the LLM provider settings from environment variables. Throws a readable error on bad config. */
export function resolveLlmSettings(env: Record<string, string | undefined>): LlmSettings {
  const read = (name: string) => env[name]?.trim() || undefined;
  const provider = read("LLM_PROVIDER") ?? "openai-compatible";

  if (provider === "anthropic") {
    if (!read("ANTHROPIC_API_KEY")) {
      throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY (copy .env.example to .env).");
    }
    return { provider, model: read("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL };
  }
  if (provider !== "openai-compatible") {
    throw new Error(`Unknown LLM_PROVIDER "${provider}". Use "openai-compatible" (local models) or "anthropic".`);
  }

  const model = read("LLM_MODEL");
  if (!model) {
    throw new Error(
      "LLM_MODEL is required for LLM_PROVIDER=openai-compatible (e.g. LLM_MODEL=qwen3:8b for Ollama). See .env.example.",
    );
  }
  const rawTemperature = read("LLM_TEMPERATURE");
  const temperature = rawTemperature === undefined ? DEFAULT_TEMPERATURE : Number(rawTemperature);
  if (!Number.isFinite(temperature) || temperature < 0) {
    throw new Error(`LLM_TEMPERATURE must be a non-negative number, got "${rawTemperature}".`);
  }
  return {
    provider,
    model,
    baseUrl: read("LLM_BASE_URL") ?? DEFAULT_BASE_URL,
    // Local servers ignore the key, but the OpenAI client refuses to start without one.
    apiKey: read("LLM_API_KEY") ?? "not-needed",
    temperature,
    disableThinking: read("LLM_DISABLE_THINKING")?.toLowerCase() !== "false",
  };
}

/** Short human-readable label for banners and logs. */
export function describeLlm(settings: LlmSettings): string {
  return settings.provider === "anthropic" ? `anthropic ${settings.model}` : `${settings.model} @ ${settings.baseUrl}`;
}

/** One model reply plus token usage when the provider reports it. */
export interface LlmCallResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmTraceMeta {
  /** `gen_ai.provider.name` (e.g. "anthropic", or "openai-compatible" for local OpenAI-style servers). */
  provider: string;
  model: string;
  serverAddress?: string;
}

/**
 * Wraps a model call in an OTel GenAI `chat` span (operation, provider, model, token usage).
 * Usage is read from LangChain's `usage_metadata`; when a server does not report it the
 * attributes are simply absent and the trace marks token totals as incomplete.
 */
export function tracedLlm(meta: LlmTraceMeta, call: (system: string, user: string) => Promise<LlmCallResult>): Llm {
  const attributes: Attributes = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": meta.provider,
    "gen_ai.request.model": meta.model,
    ...(meta.serverAddress ? { "server.address": meta.serverAddress } : {}),
  };
  return (system, user) =>
    withSpan(`chat ${meta.model}`, attributes, async (span) => {
      const { text, usage } = await call(system, user);
      if (usage) span.setAttributes({ "gen_ai.usage.input_tokens": usage.inputTokens, "gen_ai.usage.output_tokens": usage.outputTokens });
      return text;
    });
}

/** Token usage from a LangChain AIMessage, if the provider reported it. */
function usageOf(message: { usage_metadata?: { input_tokens: number; output_tokens: number } }): LlmCallResult["usage"] {
  const usage = message.usage_metadata;
  return usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function createLlm(settings: LlmSettings): Llm {
  return settings.provider === "anthropic" ? createClaudeLlm(settings.model) : createOpenAiCompatibleLlm(settings);
}

export function createClaudeLlm(model: string): Llm {
  const chat = new ChatAnthropic({ model, maxTokens: 4096, outputConfig: { effort: "low" } });
  return tracedLlm({ provider: "anthropic", model }, async (system, user) => {
    const response = await chat.invoke([new SystemMessage(system), new HumanMessage(user)]);
    return { text: response.text, usage: usageOf(response) };
  });
}

function createOpenAiCompatibleLlm(settings: Extract<LlmSettings, { provider: "openai-compatible" }>): Llm {
  const chat = new ChatOpenAI({
    model: settings.model,
    apiKey: settings.apiKey,
    temperature: settings.temperature,
    maxTokens: 4096,
    // Fail fast when the local server is down instead of retrying for minutes.
    maxRetries: 1,
    configuration: { baseURL: settings.baseUrl },
    // Hint for Qwen3-style chat templates (llama.cpp honors it; servers that do not know it ignore it).
    modelKwargs: settings.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : undefined,
  });
  const meta = { provider: "openai-compatible", model: settings.model, serverAddress: hostOf(settings.baseUrl) };
  return tracedLlm(meta, async (system, user) => {
    try {
      const response = await chat.invoke([new SystemMessage(system), new HumanMessage(user)]);
      return { text: stripThinking(response.text), usage: usageOf(response) };
    } catch (error) {
      throw new Error(describeLlmError(error, settings), { cause: error });
    }
  });
}

/** Turns common local-server failures into actionable messages. */
export function describeLlmError(error: unknown, settings: LlmSettings): string {
  const message = error instanceof Error ? error.message : String(error);
  if (settings.provider !== "openai-compatible") return message;

  const name = error instanceof Error ? error.name : "";
  if (name === "APIConnectionError" || /connection error|ECONNREFUSED|fetch failed/i.test(message)) {
    return (
      `Cannot reach the local model server at ${settings.baseUrl}. ` +
      "Start it (Ollama: `ollama serve`; llama.cpp: `llama-server --port 8080`) or fix LLM_BASE_URL."
    );
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 404 && /model/i.test(message)) {
    return `Model "${settings.model}" is not available at ${settings.baseUrl}. With Ollama run \`ollama pull ${settings.model}\`, or fix LLM_MODEL.`;
  }
  return message;
}

/** Removes `<think>...</think>` reasoning emitted by reasoning models (Qwen3, Bonsai) from a reply. */
export function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Some chat templates put the opening tag in the prompt, so only the closing tag shows up.
  const orphanClose = out.search(/<\/think>/i);
  if (orphanClose !== -1) out = out.slice(orphanClose + "</think>".length);
  // A block cut off by the token limit never closes.
  const unterminated = out.search(/<think>/i);
  if (unterminated !== -1) out = out.slice(0, unterminated);
  return out.trim();
}

/**
 * Extracts the first JSON object found in a model reply. Tolerates reasoning blocks,
 * surrounding prose, ```json fences and stray braces in the prose.
 */
export function extractJson(text: string): unknown {
  const cleaned = stripThinking(text);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned)?.[1];
  for (const source of fenced ? [fenced, cleaned] : [cleaned]) {
    for (const candidate of balancedObjects(source)) {
      try {
        const value: unknown = JSON.parse(candidate);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
      } catch {
        // Not JSON (e.g. "{placeholder}" in prose); try the next brace group.
      }
    }
  }
  return undefined;
}

/** Yields every balanced `{...}` substring, in order of its opening brace, skipping braces inside strings. */
function* balancedObjects(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}" && --depth === 0) {
        yield text.slice(start, i + 1);
        break;
      }
    }
  }
}
