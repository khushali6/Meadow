import type { ProviderId } from "../config";
import { assertKey, metadataOf, resolveProvider } from "./catalog";
import { LlmError, unsupported } from "./errors";
import { providerFetch } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, LlmProvider } from "./types";

/** FreeLLMAPI, OpenAI, Gemini (OpenAI endpoint), OpenRouter, Ollama, LM Studio and generic OpenAI-compatible servers. */
export class OpenAICompatibleProvider implements LlmProvider {
  constructor(readonly id: ProviderId) {}

  private get resolved() {
    return resolveProvider(this.id);
  }

  metadata() {
    return metadataOf(this.resolved);
  }

  private headers(json = true): Record<string, string> {
    const resolved = this.resolved;
    assertKey(resolved);
    return {
      ...(resolved.key ? { authorization: `Bearer ${resolved.key}` } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.id === "openrouter" ? { "x-title": "Meadow" } : {}),
    };
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const resolved = this.resolved;
    const model = options.model ?? resolved.model;
    if (!model) throw new LlmError(`Choose a model for ${resolved.name} in Runtime settings → Agent model.`, undefined, { type: "CONFIG", provider: this.id, retryable: false });
    const body: Record<string, unknown> = { model, messages, temperature: options.temperature ?? 0.2, max_tokens: options.maxTokens ?? 4096 };
    const wantJson = options.json && resolved.capabilities.jsonMode;
    if (wantJson) body.response_format = { type: "json_object" };
    const send = () => providerFetch(resolved, `${resolved.baseUrl}/chat/completions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: options.signal });
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (!(wantJson && error instanceof LlmError && error.type === "BAD_REQUEST")) throw error;
      delete body.response_format;
      response = await send();
    }
    const data = (await response.json()) as { model?: string; choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = data.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.text ?? "").join("") : "";
    if (!text.trim()) throw new LlmError(`${resolved.name} returned an empty completion`, undefined, { type: "SERVER", provider: this.id });
    return { text, model: data.model ?? model, tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0, provider: this.id };
  }

  async embed(texts: string[]): Promise<number[][]> {
    const resolved = this.resolved;
    if (!resolved.capabilities.embeddings || !resolved.embeddingModel) throw unsupported(this.id, `${resolved.name} has no embedding model configured.`);
    const response = await providerFetch(resolved, `${resolved.baseUrl}/embeddings`, { method: "POST", headers: this.headers(), body: JSON.stringify({ model: resolved.embeddingModel, input: texts }) });
    const data = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
    return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
  }

  async transcribe(audio: Buffer, filename: string): Promise<string> {
    const resolved = this.resolved;
    if (!resolved.capabilities.transcription) throw unsupported(this.id, `${resolved.name} can't transcribe audio.`);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)]), filename);
    form.append("model", resolved.transcriptionModel);
    const response = await providerFetch(resolved, `${resolved.baseUrl}/audio/transcriptions`, { method: "POST", headers: this.headers(false), body: form });
    const data = (await response.json()) as { text?: string };
    return (data.text ?? "").trim();
  }

  async models(): Promise<string[]> {
    const resolved = this.resolved;
    const response = await providerFetch(resolved, `${resolved.baseUrl}/models`, { method: "GET", headers: this.headers() }, 1);
    const data = (await response.json()) as { data?: Array<{ id: string }>; models?: Array<{ name?: string; id?: string }> };
    return (data.data ?? []).map(model => model.id.replace(/^models\//, ""));
  }
}
