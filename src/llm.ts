import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

/** Minimal text-in/text-out contract so graph nodes can be tested with a fake model. */
export type Llm = (system: string, user: string) => Promise<string>;

export function createClaudeLlm(model: string): Llm {
  const chat = new ChatAnthropic({ model, maxTokens: 4096, outputConfig: { effort: "low" } });
  return async (system, user) => {
    const response = await chat.invoke([new SystemMessage(system), new HumanMessage(user)]);
    return response.text;
  };
}

/** Extracts the first JSON object found in a model reply (tolerates prose and code fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
