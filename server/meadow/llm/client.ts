import { LlmError } from "./errors";
import { LlmRouter } from "./router";
import type { ChatMessage, ChatOptions, LlmClient } from "./types";

export { LlmError, ProviderError, type ProviderErrorType } from "./errors";
export type { ChatMessage, ChatOptions, ChatResult, LlmClient } from "./types";

/** Extract the first JSON object from a model reply (tolerates code fences and prose). */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new LlmError("Model reply did not contain a JSON object", undefined, { type: "BAD_REQUEST", retryable: false });
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

export async function chatJson<T>(client: LlmClient, messages: ChatMessage[], validate: (value: unknown) => T, options: ChatOptions = {}, attempts = 3): Promise<T> {
  let lastError: unknown;
  let conversation = messages;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const reply = await client.chat(conversation, { ...options, json: true });
    try {
      return validate(extractJson(reply.text));
    } catch (error) {
      lastError = error;
      conversation = [...messages, { role: "assistant", content: reply.text }, { role: "user", content: `That reply was not valid: ${(error as Error).message}. Reply again with only the corrected JSON object.` }];
    }
  }
  throw lastError instanceof Error ? lastError : new LlmError("Could not get valid JSON from the model");
}

let client: LlmClient = new LlmRouter();

export const getLlm = () => client;

export function setLlm(next: LlmClient | null) {
  client = next ?? new LlmRouter();
}
