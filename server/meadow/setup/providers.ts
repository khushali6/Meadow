import { getSecret, loadConfig, saveConfig, setSecret, type ProviderId } from "../config";
import { isConfigured, PROVIDERS, resolveProvider } from "../llm/catalog";
import { healthCheck } from "../llm/router";
import type { ProviderHealth } from "../llm/types";
import { listLocalModels, pickLocalModels, type RankedModel } from "./localModels";

export type ModelChoice = Pick<RankedModel, "id" | "kind" | "fits" | "note" | "paramsB" | "sizeBytes">;
export type DetectedProvider = {
  id: ProviderId;
  name: string;
  type: "local" | "cloud" | "custom";
  available: boolean;
  /** The server answers but Meadow has no key for it yet. */
  needsKey: boolean;
  reason: string;
  models: string[];
  active: boolean;
  secret: string | null;
  keyRequired: boolean;
  keySet: boolean;
  keyHint: string;
  /** Chat models ranked best first (local servers), and Meadow's pick with the reason. */
  choices: ModelChoice[];
  recommendedModel: string | null;
  embeddingModel: string | null;
  pickReason: string;
  currentModel: string;
};
export type ProviderScan = { providers: DetectedProvider[]; recommended: ProviderId | null; engineKeys: string[]; note: string };

const ENGINE_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CURSOR_API_KEY"] as const;

async function probe(url: string, path: string, key?: string): Promise<{ status: number; models: string[] } | null> {
  try {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1500), headers: key ? { authorization: `Bearer ${key}` } : {} });
    if (!response.ok && response.status !== 401 && response.status !== 403) return null;
    const data = (await response.json().catch(() => ({}))) as { data?: Array<{ id: string }>; models?: Array<{ name: string }> };
    return { status: response.status, models: (data.data?.map(model => model.id) ?? data.models?.map(model => model.name) ?? []).slice(0, 200) };
  } catch {
    return null;
  }
}

/**
 * Finds providers without asking: agent keys in the environment or secrets file, and model servers
 * listening on this machine. Engine keys are reported but never borrowed for the agent.
 */
export async function scanProviders(): Promise<ProviderScan> {
  const active = loadConfig().llm.provider;
  const providers: DetectedProvider[] = [];
  for (const def of Object.values(PROVIDERS)) {
    if (def.id === "custom") continue;
    const resolved = resolveProvider(def.id);
    const base = { id: def.id, name: def.name, type: def.type, active: def.id === active, models: [] as string[], secret: def.secret, keyRequired: def.keyRequired, keySet: Boolean(resolved.key), keyHint: def.keyHint, choices: [] as ModelChoice[], recommendedModel: null as string | null, embeddingModel: null as string | null, pickReason: "", currentModel: resolved.model };
    if (def.type === "local") {
      const host = new URL(resolved.baseUrl).host;
      if (def.id === "ollama" || def.id === "lmstudio") {
        const models = await listLocalModels(def.id, resolved.baseUrl);
        if (!models) {
          providers.push({ ...base, available: false, needsKey: false, reason: `Nothing listening at ${host}` });
          continue;
        }
        const pick = pickLocalModels(models);
        const choices = pick.ranked.map(({ id, kind, fits, note, paramsB, sizeBytes }) => ({ id, kind, fits, note, paramsB, sizeBytes }));
        providers.push({ ...base, available: Boolean(pick.chat), needsKey: false, models: models.map(model => model.id), choices, recommendedModel: pick.chat, embeddingModel: def.capabilities.embeddings ? pick.embedding : null, pickReason: pick.reason, reason: `Running at ${host} · ${models.length} models${pick.chat ? "" : " · no usable chat model"}` });
        continue;
      }
      const found = await probe(resolved.baseUrl, "/models", resolved.key);
      if (!found) {
        providers.push({ ...base, available: false, needsKey: false, reason: `Nothing listening at ${host}` });
        continue;
      }
      const keyRejected = found.status === 401 || found.status === 403;
      const keyOk = !def.keyRequired || (Boolean(resolved.key) && !keyRejected);
      const reason = !resolved.key && def.keyRequired ? `Running at ${host}, but ${def.secret} is not set` : keyRejected ? `Running at ${host}, but it rejected the saved key` : `Running at ${host}${found.models.length ? ` · ${found.models.length} models` : ""}`;
      providers.push({ ...base, available: keyOk, needsKey: !keyOk, models: found.models, recommendedModel: resolved.model, reason });
    } else {
      const has = def.secret ? Boolean(getSecret(def.secret)) : false;
      providers.push({ ...base, available: has, needsKey: !has, recommendedModel: resolved.model, reason: has ? `${def.secret} saved` : `Add your ${def.name} key to use it` });
    }
  }
  const pick = (ids: ProviderId[]) => ids.find(id => providers.find(provider => provider.id === id)?.available) ?? null;
  const current = providers.find(provider => provider.active && provider.available && isConfigured(provider.id));
  const recommended = current?.id ?? pick(["freellmapi", "ollama", "lmstudio"]) ?? pick(["openai", "anthropic", "gemini", "openrouter"]);
  const engineKeys = ENGINE_KEYS.filter(name => getSecret(name));
  const note = engineKeys.length && !recommended ? `${engineKeys.join(", ")} ${engineKeys.length === 1 ? "is" : "are"} set for coding engines. Meadow keeps engine and agent keys apart; add an agent key (e.g. AGENT_OPENAI_API_KEY) to use the same account for the agent.` : "";
  return { providers, recommended, engineKeys, note };
}

export class ProviderSetupError extends Error {}

/** Saves an agent key for a provider. Only the provider's own secret name can be written. */
export function saveProviderKey(id: ProviderId, key: string) {
  const def = PROVIDERS[id];
  if (!def.secret) throw new ProviderSetupError(`${def.name} doesn't use a key.`);
  const value = key.trim();
  if (value.length < 8 || /\s/.test(value)) throw new ProviderSetupError("That doesn't look like an API key.");
  setSecret(def.secret, value);
}

/**
 * Makes a provider the agent's provider with the chosen model, optionally moves memory embeddings to a local
 * embedding model on the same server, then runs the full connection test (including a real chat).
 */
export async function useProvider(id: ProviderId, options: { model?: string | null; embeddingModel?: string | null } = {}): Promise<ProviderHealth> {
  const def = PROVIDERS[id];
  const config = loadConfig().llm;
  const model = options.model?.trim() || null;
  const embeddingModel = def.type === "local" && def.capabilities.embeddings ? options.embeddingModel?.trim() || null : null;
  if (id === "freellmapi") saveConfig({ llm: { provider: id, ...(model ? { model } : {}), ...(embeddingModel ? { embeddingModel } : {}) } });
  else saveConfig({ llm: { provider: id, providers: { ...config.providers, [id]: { ...config.providers[id], ...(model ? { model } : {}), ...(embeddingModel ? { embeddingModel } : {}) } } } });
  if (embeddingModel) saveConfig({ memory: { embeddings: "provider", embeddingProvider: id } });
  else if (loadConfig().memory.embeddingProvider === id && def.type !== "local") saveConfig({ memory: { embeddings: "local", embeddingProvider: null } });
  return healthCheck(id);
}
