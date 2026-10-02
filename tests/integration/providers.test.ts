import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache, saveConfig, setSecret } from "../../server/meadow/config";
import { toAnthropicMessages } from "../../server/meadow/llm/anthropic";
import { isConfigured } from "../../server/meadow/llm/catalog";
import { chatJson, getLlm, LlmError } from "../../server/meadow/llm/client";
import { embeddingRoute, healthCheck, providerFor, transcriptionRoute } from "../../server/meadow/llm/router";
import { tempHome } from "../helpers";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

let env: ReturnType<typeof tempHome>;
let server: http.Server | null = null;
let seen: Seen[] = [];

async function mockServer(handler: Handler): Promise<string> {
  seen = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

const json = (res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(data));
};

const completion = (text: string, model = "mock-model") => ({ model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });

beforeEach(() => {
  env = tempHome();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  resetConfigCache();
  env.cleanup();
});

describe("OpenAI-compatible providers", () => {
  it("sends chat to a local Ollama endpoint without a key and reports the provider", async () => {
    const baseUrl = await mockServer((req, _body, res) => json(res, 200, completion("hello")));
    saveConfig({ llm: { provider: "ollama", providers: { ollama: { baseUrl, model: "llama3.1" } } } });
    const result = await getLlm().chat([{ role: "user", content: "hi" }]);
    expect(result).toMatchObject({ text: "hello", provider: "ollama", tokensIn: 5 });
    expect(seen[0].url).toBe("/v1/chat/completions");
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(seen[0].body).model).toBe("llama3.1");
  });

  it("sends the custom provider key as a bearer token and falls back when JSON mode is rejected", async () => {
    let calls = 0;
    const baseUrl = await mockServer((_req, body, res) => {
      calls++;
      if (JSON.parse(body).response_format) return json(res, 400, { error: { message: "response_format is not supported" } });
      json(res, 200, completion('{"ok": true}'));
    });
    setSecret("LLM_API_KEY", "custom-key-123456");
    saveConfig({ llm: { provider: "custom", providers: { custom: { baseUrl, model: "qwen" } }, custom: { jsonMode: true } } });
    const value = await chatJson(getLlm(), [{ role: "user", content: "json please" }], raw => raw as { ok: boolean });
    expect(value.ok).toBe(true);
    expect(calls).toBe(2);
    expect(seen[0].headers.authorization).toBe("Bearer custom-key-123456");
  });

  it("classifies errors and only retries the retryable ones", async () => {
    let status = 401;
    let body: unknown = { error: { message: "invalid api key" } };
    const baseUrl = await mockServer((_req, _body, res) => json(res, status, body, { "retry-after": "0" }));
    saveConfig({ llm: { provider: "ollama", providers: { ollama: { baseUrl, model: "m" } } } });
    const attempt = () => getLlm().chat([{ role: "user", content: "x" }]).then(() => null, error => error as LlmError);

    let error = await attempt();
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ type: "AUTH", retryable: false, provider: "ollama" });
    expect(seen).toHaveLength(1);

    seen = [];
    status = 429;
    body = { error: { message: "You exceeded your current quota" } };
    error = await attempt();
    expect(error?.type).toBe("QUOTA");
    expect(seen).toHaveLength(1);

    seen = [];
    body = { error: { message: "slow down" } };
    error = await attempt();
    expect(error).toMatchObject({ type: "RATE_LIMIT", retryable: true });
    expect(seen).toHaveLength(4);

    seen = [];
    status = 404;
    body = { error: { message: "model 'm' not found" } };
    error = await attempt();
    expect(error?.type).toBe("INVALID_MODEL");
    expect(seen).toHaveLength(1);
  });

  it("recovers after a transient rate limit", async () => {
    let calls = 0;
    const baseUrl = await mockServer((_req, _body, res) => (++calls === 1 ? json(res, 429, { error: "busy" }, { "retry-after": "0" }) : json(res, 200, completion("done"))));
    saveConfig({ llm: { provider: "lmstudio", providers: { lmstudio: { baseUrl, model: "m" } } } });
    expect((await getLlm().chat([{ role: "user", content: "x" }])).text).toBe("done");
    expect(calls).toBe(2);
  });

  it("reports a network error with a fix when nothing is listening", async () => {
    saveConfig({ llm: { provider: "ollama", providers: { ollama: { baseUrl: "http://127.0.0.1:9/v1", model: "m" } }, timeoutMs: 2000 } });
    const error = await providerFor("ollama").models().catch(err => err as LlmError);
    expect(error).toMatchObject({ type: "NETWORK" });
    expect((error as Error).message).toMatch(/Cannot reach Ollama/);
  });
});

describe("endpoint policy", () => {
  it("keeps local providers on loopback", async () => {
    saveConfig({ llm: { provider: "ollama", providers: { ollama: { baseUrl: "https://example.com/v1", model: "m" } } } });
    await expect(getLlm().chat([{ role: "user", content: "x" }])).rejects.toMatchObject({ type: "CONFIG" });
  });

  it("refuses remote custom endpoints unless allowed, and then only over HTTPS", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(completion("remote")), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    saveConfig({ llm: { provider: "custom", providers: { custom: { baseUrl: "http://api.groq.example/v1", model: "m" } } } });
    await expect(getLlm().chat([{ role: "user", content: "x" }])).rejects.toThrow(/non-local endpoint/);
    saveConfig({ llm: { custom: { allowRemote: true } } });
    await expect(getLlm().chat([{ role: "user", content: "x" }])).rejects.toThrow(/HTTPS/);
    saveConfig({ llm: { providers: { custom: { baseUrl: "https://api.groq.example/v1" } } } });
    expect((await getLlm().chat([{ role: "user", content: "x" }])).text).toBe("remote");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("pins cloud providers to their official host", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    setSecret("AGENT_OPENAI_API_KEY", "sk-test-1234567890");
    saveConfig({ llm: { provider: "openai", providers: { openai: { baseUrl: "https://evil.example/v1" } } } });
    await expect(getLlm().chat([{ role: "user", content: "x" }])).rejects.toThrow(/may only be called at https:\/\/api.openai.com/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks for a key before calling a cloud provider", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    saveConfig({ llm: { provider: "gemini" } });
    expect(isConfigured("gemini")).toBe(false);
    await expect(getLlm().chat([{ role: "user", content: "x" }])).rejects.toMatchObject({ type: "CONFIG" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Anthropic", () => {
  it("moves system prompts to the top level and merges turns so the first is from the user", () => {
    const out = toAnthropicMessages([
      { role: "system", content: "be brief" },
      { role: "assistant", content: "earlier" },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ], true);
    expect(out.system).toMatch(/be brief/);
    expect(out.system).toMatch(/JSON/);
    expect(out.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(out.messages[2].content).toBe("a\n\nb");
  });

  it("calls the Messages API with the agent key, separate from the engine key", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ model: "claude-sonnet-4-5", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    process.env.ANTHROPIC_API_KEY = "engine-key-should-not-be-used";
    setSecret("AGENT_ANTHROPIC_API_KEY", "sk-ant-agent-123456");
    saveConfig({ llm: { provider: "anthropic" } });
    try {
      const result = await getLlm().chat([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
      expect(result).toMatchObject({ text: "OK", provider: "anthropic", tokensIn: 3 });
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-agent-123456");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      const body = JSON.parse(String(init.body));
      expect(body.system).toBe("sys");
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("capability routing", () => {
  it("keeps memory embeddings local and refuses cloud embedding providers", async () => {
    expect(embeddingRoute().mode).toBe("local");
    await expect(getLlm().embed(["x"])).rejects.toMatchObject({ type: "UNSUPPORTED" });
    saveConfig({ llm: { provider: "openai" }, memory: { embeddings: "provider", embeddingProvider: "openai" } });
    expect(embeddingRoute()).toMatchObject({ mode: "blocked" });
    saveConfig({ memory: { embeddingProvider: "ollama" } });
    expect(embeddingRoute()).toEqual({ mode: "provider", id: "ollama" });
  });

  it("explains how to get voice working when the chat provider can't transcribe", () => {
    saveConfig({ llm: { provider: "anthropic" } });
    const route = transcriptionRoute();
    expect("reason" in route && route.reason).toMatch(/can't transcribe/);
    saveConfig({ llm: { transcriptionProvider: "openai" } });
    expect(transcriptionRoute()).toEqual({ id: "openai" });
    saveConfig({ llm: { transcriptionProvider: "off" } });
    expect("reason" in transcriptionRoute()).toBe(true);
  });

  it("runs a structured health check against a mock server", async () => {
    const baseUrl = await mockServer((req, _body, res) => (req.url?.endsWith("/models") ? json(res, 200, { data: [{ id: "llama3.1" }, { id: "nomic-embed-text" }] }) : req.url?.endsWith("/embeddings") ? json(res, 200, { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }) : json(res, 200, completion("OK"))));
    saveConfig({ llm: { provider: "ollama", providers: { ollama: { baseUrl, model: "llama3.1" } } }, memory: { embeddings: "provider", embeddingProvider: "ollama" } });
    const health = await healthCheck("ollama");
    expect(health.ok).toBe(true);
    expect(Object.fromEntries(health.steps.map(step => [step.name, step.ok]))).toMatchObject({ Credentials: true, Endpoint: true, Model: true, Chat: true, Embeddings: true });
    expect(health.steps.find(step => step.name === "Embeddings")?.detail).toMatch(/3 dimensions/);

    saveConfig({ llm: { providers: { ollama: { model: "missing-model" } } } });
    const bad = await healthCheck("ollama", { chat: false });
    expect(bad.ok).toBe(false);
    expect(bad.steps.find(step => step.name === "Model")?.errorType).toBe("INVALID_MODEL");
  });

  it("stops at credentials when a required key is missing", async () => {
    const health = await healthCheck("openrouter");
    expect(health.ok).toBe(false);
    expect(health.steps).toHaveLength(1);
    expect(health.steps[0]).toMatchObject({ name: "Credentials", errorType: "CONFIG" });
  });
});
