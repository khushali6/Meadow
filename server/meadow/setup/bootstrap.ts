import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { getSecret, homePath, saveConfig, SECRET_NAMES, setSecret, storedSecret, type ProviderId, type SecretName } from "../config";
import { capture, findBinary, isWindows } from "../core/exec";
import { getDb } from "../core/db";
import { PROVIDERS } from "../llm/catalog";
import { screenshotStatus } from "../visual/capture";
import { engineJob, connectEngine, installEngine, saveEngineKey, scanEngines, selectEngine, type EngineOption } from "./engines";
import { markStep } from "./onboarding";
import { saveProviderKey, scanProviders, useProvider } from "./providers";

/** How setup talks to the user. Non-interactive runs answer every question with its default. */
export type SetupIO = {
  interactive: boolean;
  /** Accept defaults for steps that install software or copy credentials (`--yes`). */
  yes: boolean;
  log: (line?: string) => void;
  ask: (question: string, fallback?: string, options?: { secret?: boolean }) => Promise<string>;
  /** Resolves with the promise's value, or null if the user presses Enter first. */
  waitOrSkip: <T>(work: Promise<T>, prompt: string) => Promise<T | null>;
};

/** Yes/no with a default. Steps that need consent (installs, downloads, copying a login) say no when nobody can answer. */
export async function confirm(io: SetupIO, question: string, fallback: boolean, consent = false): Promise<boolean> {
  if (!io.interactive) return consent ? io.yes && fallback : fallback;
  const answer = (await io.ask(`${question} (${fallback ? "Y/n" : "y/N"})`, "")).trim().toLowerCase();
  return answer ? answer.startsWith("y") : fallback;
}

/** KEY=VALUE lines; comments, blanks and `export ` prefixes are allowed. Values may be quoted. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith("#")) continue;
    out[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Saves every known secret found in `sources` that isn't stored yet (or differs). Unknown names are ignored. Returns the names saved. */
export function importSecrets(sources: Record<string, string | undefined>): SecretName[] {
  const saved: SecretName[] = [];
  for (const name of SECRET_NAMES) {
    const value = sources[name]?.trim();
    if (!value || /\s/.test(value) || value.length < 8) continue;
    if (storedSecret(name) === value) continue;
    setSecret(name, value);
    saved.push(name);
  }
  return saved;
}

/** Which agent provider an API key belongs to, from its prefix. */
export function providerForKey(key: string): ProviderId | null {
  const value = key.trim();
  if (value.startsWith("sk-ant-")) return "anthropic";
  if (value.startsWith("sk-or-")) return "openrouter";
  if (value.startsWith("AIza")) return "gemini";
  if (value.startsWith("sk-")) return "openai";
  return null;
}

export function validBotToken(token: string) {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/** The running daemon for this MEADOW_HOME, if any. */
export function runningDaemon(): { pid: number; url: string | null } | null {
  try {
    const held = JSON.parse(fs.readFileSync(homePath("daemon.json"), "utf8")) as { pid: number; url?: string };
    process.kill(held.pid, 0);
    return { pid: held.pid, url: held.url ?? null };
  } catch {
    return null;
  }
}

/** Opens an https link in the default browser (or Telegram, for t.me links). */
export function openUrl(url: string): boolean {
  if (!/^https:\/\/[^\s]+$/.test(url) || process.env.MEADOW_NO_BROWSER) return false;
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : isWindows ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<T>(check: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

// ── Keys ────────────────────────────────────────────────────────────────────

export async function setupKeys(io: SetupIO, envFile?: string) {
  io.log("Keys and tokens");
  const sources: Record<string, string | undefined> = { ...process.env };
  if (envFile) {
    if (!fs.existsSync(envFile)) throw new Error(`--env-file ${envFile} doesn't exist.`);
    Object.assign(sources, parseEnvFile(fs.readFileSync(envFile, "utf8")));
  }
  const saved = importSecrets(sources);
  io.log(saved.length ? `  ✓ Saved ${saved.join(", ")} to ${homePath("secrets.env")} (readable only by you)` : "  · No new keys in the environment");
  if (!getSecret("GITHUB_TOKEN")) {
    const gh = await findBinary(["gh"]);
    if (gh && (await capture(gh, ["auth", "status"], { timeoutMs: 10_000 })).code === 0 && (await confirm(io, "  Use your GitHub CLI login for Meadow's GitHub connector (issues, PRs)? It copies the token to secrets.env", false, true))) {
      const token = (await capture(gh, ["auth", "token"], { timeoutMs: 10_000 })).stdout.trim();
      if (token) {
        setSecret("GITHUB_TOKEN", token);
        io.log("  ✓ GITHUB_TOKEN saved from the GitHub CLI");
      }
    }
  }
}

// ── Agent model ─────────────────────────────────────────────────────────────

const OLLAMA_URL = "http://127.0.0.1:11434";

async function ollamaUp() {
  try {
    return (await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** A chat model that fits in memory, plus the embedding model Meadow's memory uses. */
export function suggestedOllamaModels(totalMemBytes = os.totalmem()): string[] {
  const gb = totalMemBytes / 1024 ** 3;
  return [gb >= 24 ? "qwen2.5:14b" : gb >= 12 ? "qwen2.5:7b" : "qwen2.5:3b", "nomic-embed-text"];
}

async function useBest(io: SetupIO): Promise<boolean> {
  const scan = await scanProviders();
  const pick = scan.providers.find(provider => provider.id === scan.recommended);
  if (!pick) return false;
  const keep = pick.active && pick.currentModel && (pick.type !== "local" || pick.models.includes(pick.currentModel));
  const model = keep ? pick.currentModel : pick.type === "local" ? pick.recommendedModel : null;
  io.log(`  · Testing ${pick.name}${model ? ` with ${model}` : ""}…`);
  const health = await useProvider(pick.id, { model, embeddingModel: pick.embeddingModel });
  for (const step of health.steps) io.log(`    ${step.ok ? "✓" : "✗"} ${step.name}: ${step.detail}`);
  markStep("llm", health.ok ? "done" : "failed", health.ok ? `${pick.id} · ${health.model}` : health.steps.find(step => !step.ok)?.detail ?? "Connection test failed");
  if (pick.pickReason && pick.type === "local") io.log(`    ${pick.pickReason}`);
  return health.ok;
}

export async function setupModel(io: SetupIO) {
  io.log("\nAgent model (plans, questions, summaries)");
  if (await useBest(io)) return true;
  const ollama = await findBinary(["ollama"]);
  if (ollama && !(await ollamaUp()) && (await confirm(io, "  Ollama is installed but not running. Start it?", true))) {
    const child = spawn(ollama, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    if (await until(async () => ollamaUp(), 20_000)) io.log("  ✓ Ollama started");
    if (await useBest(io)) return true;
  }
  if (ollama && (await ollamaUp())) {
    const models = suggestedOllamaModels();
    if (await confirm(io, `  Ollama has no chat model Meadow can use. Download ${models.join(" and ")} (a few GB)?`, true, true)) {
      for (const model of models) {
        io.log(`  · ollama pull ${model}`);
        await new Promise<void>(resolve => spawn(ollama, ["pull", model], { stdio: "inherit", windowsHide: true }).on("close", () => resolve()).on("error", () => resolve()));
      }
      if (await useBest(io)) return true;
    }
  }
  if (!io.interactive) {
    io.log("  · No model configured. Install Ollama (https://ollama.com) or pass a key, e.g. FREELLMAPI_API_KEY or AGENT_OPENAI_API_KEY, then run setup again.");
    return false;
  }
  io.log(ollama ? "" : "  · No local model server found. Ollama (https://ollama.com) runs models on this computer for free.");
  for (let tries = 0; tries < 3; tries++) {
    const key = await io.ask("  Paste an API key for the agent model (OpenAI, Anthropic, Gemini, OpenRouter, FreeLLMAPI), or press Enter to skip", "", { secret: true });
    if (!key) return false;
    let provider = providerForKey(key);
    if (!provider) {
      const answer = (await io.ask("  Which provider is it for? (freellmapi | openai | anthropic | gemini | openrouter)", "freellmapi")).trim() as ProviderId;
      provider = answer in PROVIDERS ? answer : null;
    }
    if (!provider) continue;
    saveProviderKey(provider, key);
    const health = await useProvider(provider);
    for (const step of health.steps) io.log(`    ${step.ok ? "✓" : "✗"} ${step.name}: ${step.detail}`);
    markStep("llm", health.ok ? "done" : "failed", health.ok ? `${provider} · ${health.model}` : "Connection test failed");
    if (health.ok) return true;
  }
  return false;
}

// ── Coding engine ───────────────────────────────────────────────────────────

async function waitForJob(io: SetupIO, name: string, timeoutMs: number) {
  let shownUrl = false;
  const done = until(async () => {
    const job = engineJob(name);
    if (job?.url && !shownUrl) {
      shownUrl = true;
      io.log(`    If no browser opened, open this link: ${job.url}`);
    }
    return job && job.status !== "running" ? job : null;
  }, timeoutMs);
  const job = await io.waitOrSkip(done, "    Waiting… (press Enter to stop waiting)");
  if (job) io.log(`    ${job.status === "done" ? "✓" : "✗"} ${job.detail}`);
  return job?.status === "done";
}

export async function setupEngine(io: SetupIO) {
  io.log("\nCoding engine (writes the code)");
  let scan = await scanEngines();
  if (scan.editors.length) io.log(`  · Found on this computer: ${scan.editors.join(", ")}`);
  const usable = scan.engines.filter(engine => engine.status === "available");
  for (const engine of scan.engines) io.log(`  ${engine.ready ? "✓" : engine.status !== "available" ? "·" : "✗"} ${engine.label}: ${engine.detail}`);
  const options = usable.map(engine => engine.name).join(" | ");
  let name = scan.recommended ?? "cursor";
  if (io.interactive && !(usable.find(engine => engine.name === name)?.ready && usable.filter(engine => engine.ready).length === 1)) {
    const answer = (await io.ask(`  Which engine should Meadow use? (${options})`, name)).trim();
    if (usable.some(engine => engine.name === answer)) name = answer;
  }
  const current = () => scan.engines.find(engine => engine.name === name) as EngineOption;
  let engine = current();
  if (!engine.installed && engine.install) {
    if (engine.install.missing) io.log(`  ✗ Installing ${engine.label} needs ${engine.install.needs}, which isn't installed.`);
    else if (await confirm(io, `  ${engine.label} isn't installed. Install it with \`${engine.install.command}\`?`, true, true)) {
      await installEngine(name);
      await waitForJob(io, name, 10 * 60_000);
      scan = await scanEngines();
      engine = current();
    }
  }
  if (engine.installed && !engine.signedIn) {
    if (engine.canLogin && (await confirm(io, `  Sign in to ${engine.label} now? It opens the sign-in page in your browser`, true, true))) {
      await connectEngine(name);
      await waitForJob(io, name, 5 * 60_000);
      scan = await scanEngines();
      engine = current();
    }
    if (!engine.signedIn && engine.key && io.interactive) {
      const key = await io.ask(`  Or paste a ${engine.key} (${engine.keyHelp}), or press Enter to skip`, "", { secret: true });
      if (key) {
        await saveEngineKey(name, key);
        scan = await scanEngines();
        engine = current();
      }
    }
  }
  if (engine.ready) {
    selectEngine(name, null);
    markStep("engine", "done", `${engine.label}${engine.version ? ` ${engine.version}` : ""} · ${engine.detail}`);
    io.log(`  ✓ ${engine.label} is connected and set as the default engine`);
    return true;
  }
  if (engine.status === "available") selectEngine(name, null);
  io.log(`  ✗ ${engine.label} isn't ready yet: ${engine.detail}. Finish it later in the dashboard: Setup → Coding engine.`);
  return false;
}

// ── Telegram ────────────────────────────────────────────────────────────────

const readOwner = () => {
  try {
    return (JSON.parse(fs.readFileSync(homePath("config.json"), "utf8")) as { telegram?: { ownerId?: number | null } }).telegram?.ownerId ?? null;
  } catch {
    return null;
  }
};

export async function setupTelegram(io: SetupIO) {
  io.log("\nTelegram (approve plans and get results on your phone)");
  const { telegram, createPairingCode } = await import("../channels/telegram");
  const { TelegramApi } = await import("../channels/telegramApi");
  const daemon = runningDaemon();
  const botName = async (token: string) => (await new TelegramApi(token).getMe()).username;

  let token = getSecret("TELEGRAM_BOT_TOKEN") ?? "";
  if (token && readOwner() !== null) {
    try {
      io.log(`  ✓ Connected to @${await botName(token)} and paired`);
      return true;
    } catch (error) {
      io.log(`  ✗ The saved bot token no longer works (${(error as Error).message}).`);
      token = "";
    }
  }
  if (!token && telegram.status().hostedAvailable && !daemon && (await confirm(io, "  Connect to the Meadow bot with one tap?", true))) {
    const link = await telegram.connectHosted();
    io.log(`  Open this link on your phone and tap Start: ${link.link}`);
    openUrl(link.link);
    const paired = await io.waitOrSkip(until(async () => readOwner() !== null, 15 * 60_000), "  Waiting for you to tap Start… (press Enter to finish later)");
    telegram.stop();
    io.log(paired ? "  ✓ Paired" : "  · Not paired yet; the link stays valid for 15 minutes once Meadow is running.");
    return Boolean(paired);
  }
  if (!token) {
    if (!io.interactive) {
      io.log("  · Skipped. Set TELEGRAM_BOT_TOKEN (from @BotFather) and run setup again, or connect later in Runtime settings → Telegram.");
      return false;
    }
    io.log("  Meadow talks to you through your own Telegram bot. Creating one takes 30 seconds:");
    io.log("    1. In Telegram, open @BotFather and send /newbot");
    io.log("    2. Pick a name and a username ending in \"bot\"");
    io.log("    3. Copy the token it sends you (looks like 123456789:AA...)");
    if (await confirm(io, "  Open @BotFather now?", true)) openUrl("https://t.me/BotFather");
    for (let tries = 0; tries < 3 && !token; tries++) {
      const candidate = (await io.ask("  Paste the bot token, or press Enter to skip", "", { secret: true })).trim();
      if (!candidate) break;
      if (!validBotToken(candidate)) {
        io.log("  ✗ That doesn't look like a bot token (digits, a colon, then about 35 characters).");
        continue;
      }
      try {
        io.log(`  ✓ Token works: @${await botName(candidate)}`);
        token = candidate;
      } catch (error) {
        io.log(`  ✗ Telegram rejected it: ${(error as Error).message}`);
      }
    }
    if (!token) {
      io.log("  · Skipped. Connect later in Runtime settings → Telegram, or run setup again.");
      return false;
    }
  }
  let bot: string;
  try {
    bot = await botName(token);
  } catch (error) {
    io.log(`  ✗ Telegram rejected the token: ${(error as Error).message}`);
    return false;
  }
  if (storedSecret("TELEGRAM_BOT_TOKEN") !== token) setSecret("TELEGRAM_BOT_TOKEN", token);
  saveConfig({ telegram: { mode: "own" } });
  if (readOwner() !== null) {
    io.log(`  ✓ Connected to @${bot} and paired`);
    return true;
  }
  const code = createPairingCode();
  const link = `https://t.me/${bot}?start=${code}`;
  io.log(`  Pair your account: open ${link} and tap Start (or send ${code} to @${bot}).`);
  openUrl(link);
  // A running daemon is already polling the bot and consumes the code itself; two pollers would conflict.
  const listen = io.interactive && !daemon;
  if (listen) await telegram.start();
  const paired = io.interactive ? await io.waitOrSkip(until(async () => readOwner() !== null, 15 * 60_000), "  Waiting for your message… (press Enter to finish later)") : null;
  if (listen) telegram.stop();
  markStep("telegram", paired ? "done" : "skipped", paired ? `@${bot}` : "Pairing pending");
  io.log(paired ? `  ✓ Paired with @${bot}. Turn on two-step verification in Telegram: this account controls Meadow.` : `  · Not paired yet. The code works for 15 minutes while Meadow is running; \`meadow pair\` makes a new one.`);
  return Boolean(paired);
}

// ── All of it ───────────────────────────────────────────────────────────────

export type SetupOptions = { envFile?: string; skip?: Array<"model" | "engine" | "telegram"> };

export async function runSetup(io: SetupIO, options: SetupOptions = {}) {
  getDb();
  const skip = new Set(options.skip ?? []);
  io.log(`Meadow setup. Everything is stored on this computer in ${homePath("")}.\n`);
  await setupKeys(io, options.envFile);
  const results = {
    model: skip.has("model") ? null : await setupModel(io),
    engine: skip.has("engine") ? null : await setupEngine(io),
    telegram: skip.has("telegram") ? null : await setupTelegram(io),
  };
  io.log("\nSummary");
  const line = (label: string, ok: boolean | null, later: string) => io.log(`  ${ok === null ? "·" : ok ? "✓" : "✗"} ${label}${ok === null ? " (skipped)" : ok ? "" : ` · ${later}`}`);
  line("Agent model", results.model, "Runtime settings → Agent model");
  line("Coding engine", results.engine, "Setup → Coding engine");
  line("Telegram", results.telegram, "Runtime settings → Telegram");
  const shots = await screenshotStatus();
  io.log(`  ${shots.ok ? "✓" : "·"} Screenshots of finished apps${shots.ok ? ` (${shots.backend === "playwright" ? "Playwright" : "your installed browser, headless"})` : ` · optional: ${shots.detail}`}`);
  return results;
}
