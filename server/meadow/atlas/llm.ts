import { isConfigured, resolveProvider } from "../llm/catalog";
import { getLlm, LlmError, type ChatMessage, type ChatOptions } from "../llm/client";
import { chatProviderId } from "../llm/router";

const COOLDOWN_MS = 60_000;
let failedAt = 0;
let cooldownMs = COOLDOWN_MS;
let lastError = "";

export type LlmUsage = { calls: number; tokensIn: number; tokensOut: number };
export const emptyUsage = (): LlmUsage => ({ calls: 0, tokensIn: 0, tokensOut: 0 });

/** True when the agent provider is configured and has not failed recently. Every caller must have a deterministic fallback. */
export function llmAvailable(): boolean {
  if (process.env.MEADOW_ATLAS_NO_LLM) return false;
  if (!process.env.MEADOW_ATLAS_FORCE_LLM && !isConfigured(chatProviderId())) return false;
  return Date.now() - failedAt > cooldownMs;
}

function noteFailure(error: unknown) {
  failedAt = Date.now();
  cooldownMs = error instanceof LlmError && error.type === "QUOTA" ? 10 * 60_000 : error instanceof LlmError && error.retryAfterMs ? Math.max(error.retryAfterMs, 5_000) : COOLDOWN_MS;
  lastError = error instanceof LlmError ? `${error.type}: ${error.message}` : String((error as Error)?.message ?? error);
}

export const llmStatus = () => ({ available: llmAvailable(), provider: resolveProvider(chatProviderId()).name, lastError: lastError || null });

export async function tryChat(messages: ChatMessage[], usage: LlmUsage, options: ChatOptions = {}): Promise<string | null> {
  if (!llmAvailable()) return null;
  try {
    const result = await getLlm().chat(messages, { temperature: 0.1, maxTokens: 1200, ...options });
    usage.calls += 1;
    usage.tokensIn += result.tokensIn;
    usage.tokensOut += result.tokensOut;
    return result.text;
  } catch (error) {
    noteFailure(error);
    return null;
  }
}

export async function tryJson<T>(messages: ChatMessage[], usage: LlmUsage, validate: (value: unknown) => T | null, options: ChatOptions = {}): Promise<T | null> {
  const text = await tryChat(messages, usage, { json: true, ...options });
  if (!text) return null;
  try {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    return validate(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

/** Rough token estimate used for budget reporting when the gateway does not return usage. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);
