import { loadConfig, type ProviderId } from "../config";
import { AnthropicProvider } from "./anthropic";
import { isConfigured, PROVIDER_IDS, PROVIDERS, resolveProvider } from "./catalog";
import { LlmError, unsupported } from "./errors";
import { OpenAICompatibleProvider } from "./openaiCompatible";
import type { ChatMessage, ChatOptions, ChatResult, HealthStep, LlmClient, LlmProvider, ProviderHealth } from "./types";

const instances = new Map<ProviderId, LlmProvider>();

export function providerFor(id: ProviderId): LlmProvider {
  let provider = instances.get(id);
  if (!provider) {
    if (!PROVIDERS[id]) throw new LlmError(`Unknown LLM provider "${id}"`, undefined, { type: "CONFIG", provider: id, retryable: false });
    provider = PROVIDERS[id].api === "anthropic" ? new AnthropicProvider() : new OpenAICompatibleProvider(id);
    instances.set(id, provider);
  }
  return provider;
}

export const chatProviderId = (): ProviderId => loadConfig().llm.provider ?? "freellmapi";

/** Embeddings for memory come from a provider only when memory.embeddings is "provider" and that provider runs locally. */
export function embeddingRoute(): { mode: "local" } | { mode: "provider"; id: ProviderId } | { mode: "blocked"; reason: string } {
  const memory = loadConfig().memory;
  if (memory.embeddings !== "provider") return { mode: "local" };
  const id = memory.embeddingProvider ?? chatProviderId();
  const resolved = resolveProvider(id);
  if (resolved.def.type !== "local" && !(id === "custom" && !loadConfig().llm.custom.allowRemote)) return { mode: "blocked", reason: `Memory stays on this machine, so embeddings can't be computed by ${resolved.name}. Pick a local provider (FreeLLMAPI, Ollama, LM Studio) or local embeddings.` };
  if (!resolved.capabilities.embeddings || !resolved.embeddingModel) return { mode: "blocked", reason: `${resolved.name} has no embedding model configured.` };
  return { mode: "provider", id };
}

export function transcriptionRoute(): { id: ProviderId } | { reason: string } {
  const choice = loadConfig().llm.transcriptionProvider ?? "auto";
  if (choice === "off") return { reason: "Voice transcription is turned off in Runtime settings → Agent model." };
  const id = choice === "auto" ? chatProviderId() : choice;
  const resolved = resolveProvider(id);
  if (!resolved.capabilities.transcription) return { reason: `${resolved.name} can't transcribe voice notes. In Runtime settings → Agent model → Voice, choose OpenAI, FreeLLMAPI or a custom endpoint that supports /audio/transcriptions, install whisper.cpp for on-device transcription, or type your message instead.` };
  return { id };
}

/** The client the rest of Meadow uses. Each call goes to the provider configured for that capability. */
export class LlmRouter implements LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    return providerFor(chatProviderId()).chat(messages, options);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const route = embeddingRoute();
    if (route.mode === "local") throw unsupported("memory", "Memory embeddings are computed locally.");
    if (route.mode === "blocked") throw unsupported("memory", route.reason);
    const provider = providerFor(route.id);
    if (!provider.embed) throw unsupported(route.id, `${provider.metadata().name} has no embeddings.`);
    return provider.embed(texts);
  }

  async transcribe(audio: Buffer, filename: string): Promise<string> {
    const route = transcriptionRoute();
    if ("reason" in route) throw unsupported("voice", route.reason);
    const provider = providerFor(route.id);
    if (!provider.transcribe) throw unsupported(route.id, `${provider.metadata().name} can't transcribe audio.`);
    return provider.transcribe(audio, filename);
  }

  models(): Promise<string[]> {
    return providerFor(chatProviderId()).models();
  }
}

const describe = (error: unknown) => ({ detail: (error as Error).message, errorType: error instanceof LlmError ? error.type : "SERVER" });

/** Structured connection test: key, endpoint, model list, a tiny chat, and embeddings when memory uses this provider. */
export async function healthCheck(id: ProviderId = chatProviderId(), options: { chat?: boolean } = {}): Promise<ProviderHealth> {
  const started = Date.now();
  const resolved = resolveProvider(id);
  const provider = providerFor(id);
  const steps: HealthStep[] = [];
  const finish = (): ProviderHealth => ({ provider: id, name: resolved.name, model: resolved.model, ok: steps.every(step => step.ok || step.skipped), steps, capabilities: resolved.capabilities, ms: Date.now() - started });

  if (resolved.def.keyRequired && !resolved.key) {
    steps.push({ name: "Credentials", ok: false, detail: `No API key saved (${resolved.def.secret}).`, errorType: "CONFIG" });
    return finish();
  }
  steps.push({ name: "Credentials", ok: true, detail: resolved.def.keyRequired ? "Key saved" : "No key needed" });
  if (!resolved.model) {
    steps.push({ name: "Model", ok: false, detail: "Choose a model.", errorType: "CONFIG" });
    return finish();
  }

  try {
    const models = await provider.models();
    const listed = models.length === 0 || resolved.model === "auto" || models.some(model => model === resolved.model || model.endsWith(`/${resolved.model}`));
    steps.push({ name: "Endpoint", ok: true, detail: `${new URL(resolved.baseUrl).host} · ${models.length} models` });
    steps.push(listed ? { name: "Model", ok: true, detail: resolved.model } : { name: "Model", ok: false, detail: `${resolved.model} is not in the provider's model list (e.g. ${models.slice(0, 3).join(", ")}).`, errorType: "INVALID_MODEL" });
  } catch (error) {
    const info = describe(error);
    steps.push({ name: "Endpoint", ok: false, ...info });
    if (info.errorType === "AUTH" || info.errorType === "NETWORK" || info.errorType === "CONFIG") return finish();
  }

  if (options.chat !== false) {
    try {
      const reply = await provider.chat([{ role: "user", content: "Reply with the single word OK." }], { maxTokens: 16, temperature: 0 });
      steps.push({ name: "Chat", ok: true, detail: `Replied "${reply.text.trim().slice(0, 20)}" via ${reply.model}` });
    } catch (error) {
      steps.push({ name: "Chat", ok: false, ...describe(error) });
    }
  }

  const route = embeddingRoute();
  if (route.mode === "provider" && route.id === id && provider.embed) {
    try {
      const [vector] = await provider.embed(["meadow connection test"]);
      steps.push({ name: "Embeddings", ok: true, detail: `${vector.length} dimensions (${resolved.embeddingModel})` });
    } catch (error) {
      steps.push({ name: "Embeddings", ok: false, ...describe(error) });
    }
  } else {
    steps.push({ name: "Embeddings", ok: true, skipped: true, detail: route.mode === "local" ? "Memory uses local embeddings" : resolved.capabilities.embeddings ? "Not used for memory" : "Not supported" });
  }

  const voice = transcriptionRoute();
  steps.push("id" in voice && voice.id === id ? { name: "Voice", ok: true, skipped: true, detail: `Transcription via ${resolved.transcriptionModel || "default model"} (not tested without audio)` } : { name: "Voice", ok: true, skipped: true, detail: resolved.capabilities.transcription ? "Not used for voice" : "Not supported" });
  return finish();
}

export function providerSummaries() {
  return PROVIDER_IDS.map(id => {
    const resolved = resolveProvider(id);
    return {
      id,
      name: resolved.name,
      type: resolved.def.type,
      secret: resolved.def.secret,
      keyRequired: resolved.def.keyRequired,
      keySet: Boolean(resolved.key),
      keyHint: resolved.def.keyHint,
      configured: isConfigured(id),
      baseUrl: resolved.baseUrl,
      baseUrlEditable: resolved.def.type !== "cloud",
      model: resolved.model,
      embeddingModel: resolved.embeddingModel,
      transcriptionModel: resolved.transcriptionModel,
      defaults: resolved.def.defaults,
      capabilities: resolved.capabilities,
    };
  });
}

export function llmRouting() {
  const chat = resolveProvider(chatProviderId());
  const embeddings = embeddingRoute();
  const voice = transcriptionRoute();
  return {
    chat: { id: chat.def.id, name: chat.name, model: chat.model, type: chat.def.type, configured: isConfigured(chat.def.id) },
    embeddings: embeddings.mode === "provider" ? { mode: "provider" as const, id: embeddings.id, name: resolveProvider(embeddings.id).name } : embeddings.mode === "local" ? { mode: "local" as const, name: "Local (on this machine)" } : { mode: "blocked" as const, reason: embeddings.reason },
    voice: "id" in voice ? { available: true as const, id: voice.id, name: resolveProvider(voice.id).name } : { available: false as const, reason: voice.reason },
  };
}
