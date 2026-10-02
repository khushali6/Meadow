import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type EngineName = "cursor" | "claude_code" | "codex" | "gemini" | "custom" | "fake";
export type NotificationLevel = "all" | "phases" | "failures";
export type PhaseGate = "auto" | "ask";

export type MeadowConfig = {
  projectsDir: string;
  server: { host: string; port: number };
  llm: { baseUrl: string; model: string; embeddingModel: string; transcriptionModel: string; timeoutMs: number };
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
  harness: { maxAttempts: number; checkTimeoutS: number; massDeleteThreshold: number; phaseGate: PhaseGate };
  budget: { phaseTokens: number; dailyTokens: number; phaseWallClockS: number };
  telegram: { ownerId: number | null; notificationLevel: NotificationLevel; quietHours: { enabled: boolean; start: number; end: number }; voiceReplies: boolean };
  screenshots: { enabled: boolean };
  approvals: { expiryS: number };
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
  };
};

export const DEFAULT_CONFIG: MeadowConfig = {
  projectsDir: path.join(os.homedir(), "meadow-projects"),
  server: { host: "127.0.0.1", port: 7777 },
  llm: { baseUrl: "http://127.0.0.1:3001/v1", model: "auto", embeddingModel: "auto", transcriptionModel: "auto", timeoutMs: 120_000 },
  engine: { default: "cursor", model: null, models: {}, runTimeoutS: 45 * 60, noOutputTimeoutS: 5 * 60, claudeUseFreeLlmApi: false, custom: { label: "Custom command", command: "" } },
  harness: { maxAttempts: 3, checkTimeoutS: 600, massDeleteThreshold: 20, phaseGate: "auto" },
  budget: { phaseTokens: 2_000_000, dailyTokens: 20_000_000, phaseWallClockS: 90 * 60 },
  telegram: { ownerId: null, notificationLevel: "all", quietHours: { enabled: false, start: 22, end: 8 }, voiceReplies: false },
  screenshots: { enabled: true },
  approvals: { expiryS: 30 * 60 },
  atlas: {
    rerank: true,
    maxAgentSteps: 8,
    connectors: {
      github: { enabled: false, repo: null },
      jira: { enabled: false, baseUrl: null, email: null, jql: "order by updated DESC" },
      linear: { enabled: false, teamKey: null },
    },
    mcpServers: [],
  },
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
export type SecretName = "FREELLMAPI_API_KEY" | "TELEGRAM_BOT_TOKEN" | "CURSOR_API_KEY" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY" | "GITHUB_TOKEN" | "JIRA_API_TOKEN" | "LINEAR_API_KEY";
export const SECRET_NAMES: SecretName[] = ["FREELLMAPI_API_KEY", "TELEGRAM_BOT_TOKEN", "CURSOR_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN", "JIRA_API_TOKEN", "LINEAR_API_KEY"];

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

export function setSecret(name: SecretName, value: string) {
  const secrets = readSecretsFile();
  secrets[name] = value;
  fs.mkdirSync(meadowHome(), { recursive: true, mode: 0o700 });
  const body = Object.entries(secrets).map(([key, val]) => `${key}=${val}`).join("\n") + "\n";
  fs.writeFileSync(homePath("secrets.env"), body, { mode: 0o600 });
  fs.chmodSync(homePath("secrets.env"), 0o600);
}
