import { getSecret, loadConfig, type AgentSecretName, type ProviderId } from "../config";
import { registerSecret } from "../core/redact";
import { configError } from "./errors";
import type { Capabilities, ProviderKind, ProviderMetadata } from "./types";

export type ProviderDef = {
  id: ProviderId;
  name: string;
  type: ProviderKind;
  api: "openai" | "anthropic";
  defaultBaseUrl: string;
  secret: AgentSecretName | null;
  keyRequired: boolean;
  capabilities: Capabilities;
  defaults: { model: string; embeddingModel: string; transcriptionModel: string };
  keyHint: string;
};

const ALL: Capabilities = { chat: true, embeddings: true, transcription: true, jsonMode: true, streaming: true };

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  freellmapi: { id: "freellmapi", name: "FreeLLMAPI (local gateway)", type: "local", api: "openai", defaultBaseUrl: "http://127.0.0.1:3001/v1", secret: "FREELLMAPI_API_KEY", keyRequired: true, capabilities: ALL, defaults: { model: "auto", embeddingModel: "auto", transcriptionModel: "auto" }, keyHint: "The unified key from the FreeLLMAPI Keys page" },
  openai: { id: "openai", name: "OpenAI", type: "cloud", api: "openai", defaultBaseUrl: "https://api.openai.com/v1", secret: "AGENT_OPENAI_API_KEY", keyRequired: true, capabilities: ALL, defaults: { model: "gpt-4.1-mini", embeddingModel: "text-embedding-3-small", transcriptionModel: "whisper-1" }, keyHint: "sk-… from platform.openai.com" },
  gemini: { id: "gemini", name: "Google Gemini", type: "cloud", api: "openai", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", secret: "AGENT_GEMINI_API_KEY", keyRequired: true, capabilities: { chat: true, embeddings: true, transcription: false, jsonMode: true, streaming: true }, defaults: { model: "gemini-2.5-flash", embeddingModel: "gemini-embedding-001", transcriptionModel: "" }, keyHint: "AIza… from aistudio.google.com" },
  anthropic: { id: "anthropic", name: "Anthropic", type: "cloud", api: "anthropic", defaultBaseUrl: "https://api.anthropic.com", secret: "AGENT_ANTHROPIC_API_KEY", keyRequired: true, capabilities: { chat: true, embeddings: false, transcription: false, jsonMode: false, streaming: true }, defaults: { model: "claude-sonnet-4-5", embeddingModel: "", transcriptionModel: "" }, keyHint: "sk-ant-… from console.anthropic.com" },
  openrouter: { id: "openrouter", name: "OpenRouter", type: "cloud", api: "openai", defaultBaseUrl: "https://openrouter.ai/api/v1", secret: "OPENROUTER_API_KEY", keyRequired: true, capabilities: { chat: true, embeddings: false, transcription: false, jsonMode: true, streaming: true }, defaults: { model: "openrouter/auto", embeddingModel: "", transcriptionModel: "" }, keyHint: "sk-or-… from openrouter.ai/keys" },
  ollama: { id: "ollama", name: "Ollama (local)", type: "local", api: "openai", defaultBaseUrl: "http://127.0.0.1:11434/v1", secret: null, keyRequired: false, capabilities: { chat: true, embeddings: true, transcription: false, jsonMode: true, streaming: true }, defaults: { model: "llama3.1", embeddingModel: "nomic-embed-text", transcriptionModel: "" }, keyHint: "No key needed" },
  lmstudio: { id: "lmstudio", name: "LM Studio (local)", type: "local", api: "openai", defaultBaseUrl: "http://127.0.0.1:1234/v1", secret: null, keyRequired: false, capabilities: { chat: true, embeddings: true, transcription: false, jsonMode: true, streaming: true }, defaults: { model: "local-model", embeddingModel: "text-embedding-nomic-embed-text-v1.5", transcriptionModel: "" }, keyHint: "No key needed" },
  custom: { id: "custom", name: "OpenAI-compatible", type: "custom", api: "openai", defaultBaseUrl: "http://127.0.0.1:8000/v1", secret: "LLM_API_KEY", keyRequired: false, capabilities: { chat: true, embeddings: false, transcription: false, jsonMode: false, streaming: true }, defaults: { model: "", embeddingModel: "", transcriptionModel: "" }, keyHint: "Optional key for Groq, Mistral, DeepSeek, Together, vLLM…" },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export const isProviderId = (value: unknown): value is ProviderId => typeof value === "string" && value in PROVIDERS;

export type ResolvedProvider = { def: ProviderDef; name: string; baseUrl: string; model: string; embeddingModel: string; transcriptionModel: string; key: string | undefined; capabilities: Capabilities; timeoutMs: number };

/** Current settings for a provider: defaults, overlaid with config. FreeLLMAPI keeps its settings at the top of `llm`. */
export function resolveProvider(id: ProviderId): ResolvedProvider {
  const def = PROVIDERS[id];
  if (!def) throw configError(String(id), `Unknown LLM provider "${id}".`);
  const config = loadConfig().llm;
  const own = id === "freellmapi" ? { baseUrl: config.baseUrl, model: config.model, embeddingModel: config.embeddingModel, transcriptionModel: config.transcriptionModel } : config.providers?.[id] ?? {};
  const key = def.secret ? getSecret(def.secret) : undefined;
  registerSecret(key);
  const capabilities = id === "custom" ? { ...def.capabilities, embeddings: config.custom.embeddings, transcription: config.custom.transcription, jsonMode: config.custom.jsonMode } : def.capabilities;
  return {
    def,
    name: id === "custom" ? config.custom.label || def.name : def.name,
    baseUrl: (own.baseUrl || def.defaultBaseUrl).replace(/\/$/, ""),
    model: own.model || def.defaults.model,
    embeddingModel: own.embeddingModel || def.defaults.embeddingModel,
    transcriptionModel: own.transcriptionModel || def.defaults.transcriptionModel,
    key,
    capabilities,
    timeoutMs: config.timeoutMs,
  };
}

export const metadataOf = (resolved: ResolvedProvider): ProviderMetadata => ({ id: resolved.def.id, name: resolved.name, type: resolved.def.type, capabilities: resolved.capabilities });

const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]", "host.docker.internal"];

/**
 * Where a provider may send data. Local providers: loopback only. Cloud providers: only their
 * official host over HTTPS. Custom: loopback unless explicitly allowed. MEADOW_ALLOW_REMOTE_LLM
 * lifts the loopback rule for local and custom providers.
 */
export function assertEndpointAllowed(resolved: ResolvedProvider, url: string) {
  const { def } = resolved;
  const target = new URL(url);
  const allowRemote = Boolean(process.env.MEADOW_ALLOW_REMOTE_LLM) || (def.id === "custom" && loadConfig().llm.custom.allowRemote);
  if (def.type === "cloud") {
    const official = new URL(def.defaultBaseUrl);
    if (target.hostname !== official.hostname || target.protocol !== "https:") throw configError(def.id, `${def.name} may only be called at ${official.origin}; refusing ${target.origin}.`);
    return;
  }
  if (LOOPBACK.includes(target.hostname)) return;
  if (!allowRemote) throw configError(def.id, `Refusing to send data to non-local endpoint ${target.hostname} for ${resolved.name}. Local providers must run on this machine${def.id === "custom" ? '; turn on "Allow remote endpoint" for a hosted OpenAI-compatible API' : ""} (or set MEADOW_ALLOW_REMOTE_LLM=1).`);
  if (target.protocol !== "https:") throw configError(def.id, `Remote endpoints must use HTTPS (${target.origin}).`);
}

export function assertKey(resolved: ResolvedProvider) {
  if (resolved.def.keyRequired && !resolved.key) throw configError(resolved.def.id, `${resolved.name} needs an API key (${resolved.def.secret}). Add it in Runtime settings → Agent model, or put it in ~/.meadow/secrets.env.`);
}

export const isConfigured = (id: ProviderId) => {
  const resolved = resolveProvider(id);
  return (!resolved.def.keyRequired || Boolean(resolved.key)) && (id !== "custom" || Boolean(resolved.model));
};
