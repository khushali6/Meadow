import { assertKey, metadataOf, resolveProvider } from "./catalog";
import { LlmError } from "./errors";
import { providerFetch } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, LlmProvider } from "./types";

const VERSION = "2023-06-01";

/**
 * Anthropic Messages API. System prompts go in the top-level `system` field, turns must
 * alternate starting with the user, and there is no JSON mode, so JSON is requested in the
 * system prompt and parsed by the caller's tolerant extractor.
 */
export function toAnthropicMessages(messages: ChatMessage[], json = false): { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const system = messages.filter(message => message.role === "system").map(message => message.content);
  if (json) system.push("Reply with only a single valid JSON object. No prose, no code fences.");
  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const last = turns[turns.length - 1];
    if (last && last.role === message.role) last.content += `\n\n${message.content}`;
    else turns.push({ role: message.role, content: message.content });
  }
  if (!turns.length || turns[0].role !== "user") turns.unshift({ role: "user", content: "(continue)" });
  return { system: system.join("\n\n"), messages: turns };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic" as const;

  private get resolved() {
    return resolveProvider(this.id);
  }

  metadata() {
    return metadataOf(this.resolved);
  }

  private headers(): Record<string, string> {
    const resolved = this.resolved;
    assertKey(resolved);
    return { "x-api-key": resolved.key!, "anthropic-version": VERSION, "content-type": "application/json" };
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const resolved = this.resolved;
    const model = options.model ?? resolved.model;
    const { system, messages: turns } = toAnthropicMessages(messages, options.json);
    const body = { model, max_tokens: options.maxTokens ?? 4096, temperature: options.temperature ?? 0.2, ...(system ? { system } : {}), messages: turns };
    const response = await providerFetch(resolved, `${resolved.baseUrl}/v1/messages`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: options.signal });
    const data = (await response.json()) as { model?: string; content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (data.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("");
    if (!text.trim()) throw new LlmError("Anthropic returned an empty completion", undefined, { type: "SERVER", provider: this.id });
    return { text, model: data.model ?? model, tokensIn: data.usage?.input_tokens ?? 0, tokensOut: data.usage?.output_tokens ?? 0, provider: this.id };
  }

  async models(): Promise<string[]> {
    const resolved = this.resolved;
    const response = await providerFetch(resolved, `${resolved.baseUrl}/v1/models`, { method: "GET", headers: this.headers() }, 1);
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map(model => model.id);
  }
}
