import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type EngineName = "cursor" | "claude_code" | "codex" | "gemini" | "custom" | "fake";
export type NotificationLevel = "all" | "phases" | "failures";
export type PhaseGate = "auto" | "ask";
export type ProviderId = "freellmapi" | "openai" | "gemini" | "anthropic" | "openrouter" | "ollama" | "lmstudio" | "custom";
export type ProviderSettings = { baseUrl?: string; model?: string; embeddingModel?: string; transcriptionModel?: string };

export type MeadowConfig = {
  projectsDir: string;
  server: { host: string; port: number };
  llm: {
    /** Provider used by the agent for chat (planning, questions, summaries, CodeAtlas). */
    provider: ProviderId;
    /**
     * Which model is used for generating SPEC.md and PLAN.md.
     * "engine": delegate to the coding engine (Cursor CLI in read-only mode) so a top-tier model writes the plan.
     * "llm": use the chat provider above (the old behaviour).
     */
    plannerEngine: "engine" | "llm";
    /** FreeLLMAPI settings (kept at this level for older configs). */
    baseUrl: string;
    model: string;
    embeddingModel: string;
    transcriptionModel: string;
    timeoutMs: number;
    /** Settings for every other provider; missing fields use the provider's defaults. */
    providers: Partial<Record<ProviderId, ProviderSettings>>;
    /** Generic OpenAI-compatible endpoint. Remote URLs need allowRemote. */
    custom: { label: string; allowRemote: boolean; embeddings: boolean; transcription: boolean; jsonMode: boolean };
    /** Who transcribes voice notes: the chat provider when it can ("auto"), a specific provider, or nobody. */
    transcriptionProvider: ProviderId | "auto" | "off";
  };
  /** Memory (code index, notes, CodeAtlas vectors) is stored locally. Embeddings are computed locally unless a local provider is chosen. */
  memory: { embeddings: "local" | "provider"; embeddingProvider: ProviderId | null };
  engine: {
    default: EngineName;
    /** Fallback model when an engine has no entry in `models`. */
    model: string | null;
    models: Partial<Record<EngineName, string | null>>;
    runTimeoutS: number;
    noOutputTimeoutS: number;
    claudeUseFreeLlmApi: boolean;
    /** Shell command for the custom engine. Receives the prompt as $MEADOW_PROMPT and $MEADOW_PROMPT_FILE. */
    custom: { label: string; command: string };
  };
  /**
   * autoResume: continue interrupted runs when Meadow restarts. autoVerify: after every phase, also run the
   * project's detected typecheck/lint/test/build commands that passed the baseline. preflightImpact: show the
   * engine what a phase's changes can affect before it starts. design: web projects get the design standard in
   * every prompt and the browser tests fail pages that still look like browser defaults.
   */
  harness: { maxAttempts: number; checkTimeoutS: number; massDeleteThreshold: number; phaseGate: PhaseGate; autoResume: boolean; autoVerify: boolean; preflightImpact: boolean; e2e: boolean; design: boolean };
  budget: { phaseTokens: number; dailyTokens: number; phaseWallClockS: number };
  /** `hosted` talks to the Meadow bot through a relay (one-click connect); `own` uses a bot token you created. */
  telegram: { mode: "hosted" | "own"; relayUrl: string; ownerId: number | null; notificationLevel: NotificationLevel; quietHours: { enabled: boolean; start: number; end: number }; voiceReplies: boolean };
  screenshots: { enabled: boolean };
  /** When a run starts, open the project in the editor and a terminal window following the engine's live output. */
  watch: { editor: boolean; terminal: boolean };
  approvals: { expiryS: number };
  /**
   * sandbox: run the coding engine in its OS sandbox when it supports one ("auto") or never ("off"); the command
   * deny-list and after-run checks apply either way. broker: let the engine ask you questions and request installs.
   */
  guard: { sandbox: "auto" | "off"; broker: boolean };
  /**
   * Connected accounts Meadow reuses for every project. github: create a private repo for projects without a remote
   * and push each passed phase. supabase: the organisation picked once (asked only when there are several).
   */
  services: { github: { createRepo: boolean; push: boolean }; supabase: { orgId: string | null; orgName: string | null } };
  atlas: {
    /** LLM reranking of fused results; falls back to fusion order when the gateway is unavailable. */
    rerank: boolean;
    maxAgentSteps: number;
    /** Opt-in issue trackers. Each one only talks to its service when enabled and its token is set. */
    connectors: {
      github: { enabled: boolean; repo: string | null };
      jira: { enabled: boolean; baseUrl: string | null; email: string | null; jql: string };
      linear: { enabled: boolean; teamKey: string | null };
    };
    /** External MCP servers the Operator agent may call (stdio). Env values are secret names, never literals. */
    mcpServers: Array<{ name: string; command: string; args: string[]; env: string[] }>;
    /** Keep the graph and memory in sync with the working tree (git changes are picked up automatically). */
    liveUpdate: boolean;
  };
  /** Signed update manifest. Empty URL turns update checks off. */
  updates: { url: string; check: boolean };
};

export const DEFAULT_CONFIG: MeadowConfig = {
  projectsDir: path.join(os.homedir(), "meadow-projects"),
  server: { host: "127.0.0.1", port: 7777 },
  llm: {
    provider: "freellmapi",
    plannerEngine: "engine",
    baseUrl: "http://127.0.0.1:3001/v1",
    model: "auto",
    embeddingModel: "auto",
    transcriptionModel: "auto",
    timeoutMs: 120_000,
    providers: {},
    custom: { label: "OpenAI-compatible", allowRemote: false, embeddings: false, transcription: false, jsonMode: false },
    transcriptionProvider: "auto",
  },
  memory: { embeddings: "local", embeddingProvider: null },
  engine: { default: "cursor", model: null, models: {}, runTimeoutS: 45 * 60, noOutputTimeoutS: 5 * 60, claudeUseFreeLlmApi: false, custom: { label: "Custom command", command: "" } },
  harness: { maxAttempts: 3, checkTimeoutS: 600, massDeleteThreshold: 20, phaseGate: "auto", autoResume: false, autoVerify: true, preflightImpact: true, e2e: true, design: true },
  budget: { phaseTokens: 2_000_000, dailyTokens: 20_000_000, phaseWallClockS: 90 * 60 },
  telegram: { mode: "hosted", relayUrl: "", ownerId: null, notificationLevel: "all", quietHours: { enabled: false, start: 22, end: 8 }, voiceReplies: false },
  screenshots: { enabled: true },
  watch: { editor: true, terminal: true },
  approvals: { expiryS: 30 * 60 },
  guard: { sandbox: "auto", broker: true },
  services: { github: { createRepo: true, push: true }, supabase: { orgId: null, orgName: null } },
  atlas: {
    rerank: true,
    maxAgentSteps: 8,
    connectors: {
      github: { enabled: false, repo: null },
      jira: { enabled: false, baseUrl: null, email: null, jql: "order by updated DESC" },
      linear: { enabled: false, teamKey: null },
    },
    mcpServers: [],
    liveUpdate: true,
  },
  updates: { url: "", check: true },
};

export function meadowHome() {
  return process.env.MEADOW_HOME || path.join(os.homedir(), ".meadow");
}

export const homePath = (...parts: string[]) => path.join(meadowHome(), ...parts);

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const current = out[key];
    out[key] = current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)
      ? deepMerge(current, value)
      : value;
  }
  return out as T;
}

function envOverrides(config: MeadowConfig): MeadowConfig {
  const env = process.env;
  const next = structuredClone(config);
  if (env.MEADOW_PROJECTS_DIR) next.projectsDir = env.MEADOW_PROJECTS_DIR;
  if (env.MEADOW_PORT) next.server.port = Number(env.MEADOW_PORT);
  if (env.FREELLMAPI_BASE_URL) next.llm.baseUrl = env.FREELLMAPI_BASE_URL;
  if (env.MEADOW_LLM_MODEL) next.llm.model = env.MEADOW_LLM_MODEL;
  if (env.MEADOW_LLM_PROVIDER) next.llm.provider = env.MEADOW_LLM_PROVIDER as ProviderId;
  if (env.MEADOW_UPDATE_URL) next.updates.url = env.MEADOW_UPDATE_URL;
  if (env.MEADOW_RELAY_URL) next.telegram.relayUrl = env.MEADOW_RELAY_URL;
  if (env.MEADOW_ENGINE) next.engine.default = env.MEADOW_ENGINE as EngineName;
  return next;
}

let cached: MeadowConfig | null = null;

export function loadConfig(): MeadowConfig {
  if (cached) return cached;
  let fileConfig: unknown = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(homePath("config.json"), "utf8"));
  } catch {
    fileConfig = {};
  }
  cached = envOverrides(deepMerge(DEFAULT_CONFIG, fileConfig));
  cached.projectsDir = cached.projectsDir.replace(/^~(?=$|\/)/, os.homedir());
  return cached;
}

export function saveConfig(patch: unknown): MeadowConfig {
  let fileConfig: unknown = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(homePath("config.json"), "utf8"));
  } catch {
    fileConfig = {};
  }
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), patch);
  fs.mkdirSync(meadowHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(homePath("config.json"), JSON.stringify(merged, null, 2), { mode: 0o600 });
  cached = null;
  return loadConfig();
}

export function engineModel(engine: string): string | null {
  const config = loadConfig().engine;
  const specific = config.models?.[engine as EngineName];
  return specific === undefined ? config.model : specific || null;
}

export function resetConfigCache() {
  cached = null;
}

/** Secrets come only from the environment or ~/.meadow/secrets.env (0600), never from config.json. */
/** Agent provider keys (AGENT_*, OPENROUTER_API_KEY, LLM_API_KEY) are separate from the coding-engine keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, CURSOR_API_KEY). */
export type AgentSecretName = "FREELLMAPI_API_KEY" | "AGENT_OPENAI_API_KEY" | "AGENT_GEMINI_API_KEY" | "AGENT_ANTHROPIC_API_KEY" | "OPENROUTER_API_KEY" | "LLM_API_KEY";
export type SecretName = AgentSecretName | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_RELAY_TOKEN" | "CURSOR_API_KEY" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY" | "GITHUB_TOKEN" | "JIRA_API_TOKEN" | "LINEAR_API_KEY";
export const AGENT_SECRET_NAMES: AgentSecretName[] = ["FREELLMAPI_API_KEY", "AGENT_OPENAI_API_KEY", "AGENT_GEMINI_API_KEY", "AGENT_ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "LLM_API_KEY"];
export const SECRET_NAMES: SecretName[] = [...AGENT_SECRET_NAMES, "TELEGRAM_BOT_TOKEN", "TELEGRAM_RELAY_TOKEN", "CURSOR_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN", "JIRA_API_TOKEN", "LINEAR_API_KEY"];

function readSecretsFile(): Record<string, string> {
  try {
    const raw = fs.readFileSync(homePath("secrets.env"), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

export function getSecret(name: SecretName): string | undefined {
  return process.env[name] || readSecretsFile()[name] || undefined;
}

/** The value saved in secrets.env only, ignoring the environment. */
export function storedSecret(name: SecretName): string | undefined {
  return readSecretsFile()[name] || undefined;
}

export function setSecret(name: SecretName, value: string) {
  const secrets = readSecretsFile();
  secrets[name] = value;
  fs.mkdirSync(meadowHome(), { recursive: true, mode: 0o700 });
  const body = Object.entries(secrets).map(([key, val]) => `${key}=${val}`).join("\n") + "\n";
  fs.writeFileSync(homePath("secrets.env"), body, { mode: 0o600 });
  fs.chmodSync(homePath("secrets.env"), 0o600);
}

export function deleteSecret(name: SecretName) {
  const secrets = readSecretsFile();
  if (!(name in secrets)) return;
  delete secrets[name];
  const body = Object.entries(secrets).map(([key, val]) => `${key}=${val}`).join("\n") + "\n";
  fs.writeFileSync(homePath("secrets.env"), body, { mode: 0o600 });
}
