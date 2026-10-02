import { getSecret, loadConfig } from "../config";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export type ChatOptions = { model?: string; maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal };

export type ChatResult = { text: string; model: string; tokensIn: number; tokensOut: number };

/**
 * Thin OpenAI-compatible client for a local FreeLLMAPI gateway (default http://127.0.0.1:3001/v1).
 * Meadow only talks to the gateway; the gateway decides which free provider serves the call.
 */
export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
  embed(texts: string[]): Promise<number[][]>;
  transcribe(audio: Buffer, filename: string): Promise<string>;
  models(): Promise<string[]>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class FreeLlmApiClient implements LlmClient {
  private get baseUrl() {
    return loadConfig().llm.baseUrl.replace(/\/$/, "");
  }

  private headers(json = true): Record<string, string> {
    const key = getSecret("FREELLMAPI_API_KEY");
    if (!key) throw new LlmError("FREELLMAPI_API_KEY is not set. Copy the unified key from http://127.0.0.1:3001 (Keys page) and run `meadow init` or add it to ~/.meadow/secrets.env.");
    return { authorization: `Bearer ${key}`, ...(json ? { "content-type": "application/json" } : {}) };
  }

  private async request(pathName: string, init: RequestInit, attempts = 4): Promise<Response> {
    const url = `${this.baseUrl}${pathName}`;
    const host = new URL(url).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]", "host.docker.internal"].includes(host) && !process.env.MEADOW_ALLOW_REMOTE_LLM) {
      throw new LlmError(`Refusing to send data to non-local LLM endpoint ${host}. Meadow only talks to a local FreeLLMAPI gateway (set MEADOW_ALLOW_REMOTE_LLM=1 to override).`);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), loadConfig().llm.timeoutMs);
      const outer = init.signal;
      outer?.addEventListener("abort", () => controller.abort(), { once: true });
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) return response;
        const body = await response.text();
        if (response.status === 401 || response.status === 403) throw new LlmError(`FreeLLMAPI rejected the key (${response.status}). Check FREELLMAPI_API_KEY.`, response.status);
        if (response.status >= 400 && response.status < 500 && response.status !== 429) throw new LlmError(`FreeLLMAPI ${response.status}: ${body.slice(0, 500)}`, response.status);
        lastError = new LlmError(`FreeLLMAPI ${response.status}: ${body.slice(0, 300)}`, response.status);
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof LlmError && error.status && error.status !== 429 && error.status < 500) throw error;
        if (outer?.aborted) throw new LlmError("Request cancelled");
        lastError = error instanceof Error && error.name === "AbortError" ? new LlmError("FreeLLMAPI request timed out") : error;
        if (error instanceof TypeError) lastError = new LlmError(`Cannot reach FreeLLMAPI at ${this.baseUrl}. Is it running? (${(error as Error).message})`);
      }
      await sleep(Math.min(8000, 600 * 2 ** attempt));
    }
    throw lastError instanceof Error ? lastError : new LlmError("FreeLLMAPI request failed");
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const config = loadConfig();
    const body: Record<string, unknown> = {
      model: options.model ?? config.llm.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 4096,
    };
    if (options.json) body.response_format = { type: "json_object" };
    let response: Response;
    try {
      response = await this.request("/chat/completions", { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: options.signal });
    } catch (error) {
      // Some upstream providers reject response_format; retry once without it.
      if (options.json && error instanceof LlmError && error.status === 400) {
        delete body.response_format;
        response = await this.request("/chat/completions", { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: options.signal });
      } else {
        throw error;
      }
    }
    const data = (await response.json()) as { model?: string; choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = data.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.text ?? "").join("") : "";
    if (!text.trim()) throw new LlmError("FreeLLMAPI returned an empty completion");
    return { text, model: data.model ?? String(body.model), tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0 };
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.request("/embeddings", { method: "POST", headers: this.headers(), body: JSON.stringify({ model: loadConfig().llm.embeddingModel, input: texts }) });
    const data = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
    return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
  }

  async transcribe(audio: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)]), filename);
    form.append("model", loadConfig().llm.transcriptionModel);
    const response = await this.request("/audio/transcriptions", { method: "POST", headers: this.headers(false), body: form });
    const data = (await response.json()) as { text?: string };
    return (data.text ?? "").trim();
  }

  async models(): Promise<string[]> {
    const response = await this.request("/models", { method: "GET", headers: this.headers() }, 1);
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map(model => model.id);
  }
}

/** Extract the first JSON object from a model reply (tolerates code fences and prose). */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new LlmError("Model reply did not contain a JSON object");
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

let client: LlmClient = new FreeLlmApiClient();

export const getLlm = () => client;

export function setLlm(next: LlmClient) {
  client = next;
}
