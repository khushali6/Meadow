import { getSecret, loadConfig, saveConfig, type ProviderId } from "../config";
import { isConfigured, PROVIDERS, resolveProvider } from "../llm/catalog";

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
};
export type ProviderScan = { providers: DetectedProvider[]; recommended: ProviderId | null; engineKeys: string[]; note: string };

const ENGINE_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CURSOR_API_KEY"] as const;

async function probe(url: string, path: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok && response.status !== 401) return null;
    const data = (await response.json().catch(() => ({}))) as { data?: Array<{ id: string }>; models?: Array<{ name: string }> };
    return (data.data?.map(model => model.id) ?? data.models?.map(model => model.name) ?? []).slice(0, 20);
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
    const base = { id: def.id, name: def.name, type: def.type, active: def.id === active, models: [] as string[] };
    if (def.type === "local") {
      const root = resolved.baseUrl.replace(/\/v1$/, "");
      const models = (await probe(resolved.baseUrl, "/models")) ?? (def.id === "ollama" ? await probe(root, "/api/tags") : null);
      const keyOk = !def.keyRequired || Boolean(resolved.key);
      providers.push({ ...base, available: Boolean(models) && keyOk, needsKey: Boolean(models) && !keyOk, models: models ?? [], reason: !models ? `Nothing listening at ${new URL(resolved.baseUrl).host}` : keyOk ? `Running at ${new URL(resolved.baseUrl).host}${models.length ? ` · ${models.length} models` : ""}` : `Running, but ${def.secret} is not set` });
    } else {
      const has = def.secret ? Boolean(getSecret(def.secret)) : false;
      providers.push({ ...base, available: has, needsKey: false, reason: has ? `${def.secret} found` : `No ${def.secret}` });
    }
  }
  const pick = (ids: ProviderId[]) => ids.find(id => providers.find(provider => provider.id === id)?.available) ?? null;
  const current = providers.find(provider => provider.active && provider.available && isConfigured(provider.id));
  const recommended = current?.id ?? pick(["freellmapi", "ollama", "lmstudio"]) ?? pick(["openai", "anthropic", "gemini", "openrouter"]);
  const engineKeys = ENGINE_KEYS.filter(name => getSecret(name));
  const note = engineKeys.length && !recommended ? `${engineKeys.join(", ")} ${engineKeys.length === 1 ? "is" : "are"} set for coding engines. Meadow keeps engine and agent keys apart; add an agent key (e.g. AGENT_OPENAI_API_KEY) to use the same account for the agent.` : "";
  return { providers, recommended, engineKeys, note };
}

/** Makes a detected provider the agent's provider, filling in a served model for local servers when the default isn't available. */
export function useProvider(id: ProviderId, models: string[] = []) {
  const def = PROVIDERS[id];
  const resolved = resolveProvider(id);
  const model = def.type === "local" && models.length && !models.includes(resolved.model) && resolved.model !== "auto" ? models[0] : null;
  if (id === "freellmapi") saveConfig({ llm: { provider: id, ...(model ? { model } : {}) } });
  else saveConfig({ llm: { provider: id, ...(model ? { providers: { ...loadConfig().llm.providers, [id]: { ...loadConfig().llm.providers[id], model } } } : {}) } });
}
