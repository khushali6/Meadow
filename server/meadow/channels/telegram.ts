import crypto from "node:crypto";
import { getSecret, loadConfig, saveConfig } from "../config";
import { getDb } from "../core/db";
import { redact, registerSecret } from "../core/redact";
import { chatInvestigate } from "../atlas/chat";
import { handleAction, handleDocument, handleText, type Reply } from "../intake/conversation";
import { statusText } from "../service";
import { captureOnDemand } from "../visual/ondemand";
import { relayUrl, requestLink, unlinkDevice, type RelayLink } from "./relay";
import { TelegramApi, type InlineButton, type TgUpdate } from "./telegramApi";
import { speak, transcribe } from "./voice";

const CHANNEL = "telegram";

function setting(key: string): string | null {
  return getDb().get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? null;
}

function setSetting(key: string, value: string | null) {
  if (value === null) getDb().run("DELETE FROM settings WHERE key = ?", key);
  else getDb().run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

/**
 * One-time pairing code, valid for 15 minutes. The first Telegram user to send it becomes the owner.
 * `link` codes travel in a t.me deep link to the shared bot, where anyone can message it, so they are
 * long and random instead of six digits.
 */
export function createPairingCode(kind: "short" | "link" = "short"): string {
  const code = kind === "link" ? crypto.randomBytes(18).toString("base64url") : crypto.randomInt(100000, 999999).toString();
  setSetting("telegram_pairing", JSON.stringify({ hash: crypto.createHash("sha256").update(code).digest("hex"), expires: Date.now() + 15 * 60_000 }));
  return code;
}

function consumePairingCode(text: string): boolean {
  const raw = setting("telegram_pairing");
  if (!raw) return false;
  const { hash, expires } = JSON.parse(raw) as { hash: string; expires: number };
  if (Date.now() > expires) {
    setSetting("telegram_pairing", null);
    return false;
  }
  const candidate = text.replace(/^\/(start|pair)(@\w+)?\s*/, "").trim();
  if (!/^\d{6}$/.test(candidate) && !/^[A-Za-z0-9_-]{24,64}$/.test(candidate)) return false;
  const ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(crypto.createHash("sha256").update(candidate).digest("hex")));
  if (ok) setSetting("telegram_pairing", null);
  return ok;
}

/** Reconnect delays in seconds; each gets ±30% jitter so many installs don't retry in lockstep. */
export const RECONNECT_STEPS = [1, 2, 5, 10, 30, 60];
export const backoffMs = (failures: number, random = Math.random) => {
  const step = RECONNECT_STEPS[Math.min(failures, RECONNECT_STEPS.length - 1)] * 1000;
  return Math.round(step * (0.7 + random() * 0.6));
};

export class TelegramChannel {
  api: TelegramApi | null = null;
  private running = false;
  private failures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  connection: { state: "connected" | "reconnecting" | "offline"; since: string; nextRetryAt: string | null } = { state: "offline", since: new Date().toISOString(), nextRetryAt: null };
  private generation = 0;
  private botName: string | null = null;
  lastError: string | null = null;

  /** Own bot token, or the hosted Meadow bot through the relay. An own token with no relay device keeps working as before. */
  credentials(): { mode: "own" | "hosted"; token: string; base: string } | null {
    const config = loadConfig().telegram;
    const own = getSecret("TELEGRAM_BOT_TOKEN");
    const device = getSecret("TELEGRAM_RELAY_TOKEN");
    if (config.mode === "own" || (own && !device)) return own ? { mode: "own", token: own, base: "https://api.telegram.org" } : null;
    const base = relayUrl();
    return device && base ? { mode: "hosted", token: device, base } : null;
  }

  status() {
    const config = loadConfig().telegram;
    const credentials = this.credentials();
    return { configured: Boolean(credentials), mode: credentials?.mode ?? config.mode, hostedAvailable: Boolean(relayUrl()), relayUrl: config.relayUrl, running: this.running, connection: this.connection, bot: this.botName, paired: config.ownerId !== null, pairingPending: Boolean(setting("telegram_pairing")), lastError: this.lastError };
  }

  /** One-click connect to the hosted bot: returns the t.me link the user opens; tapping Start pairs them. */
  async connectHosted(): Promise<RelayLink> {
    const link = await requestLink(createPairingCode("link"));
    saveConfig({ telegram: { mode: "hosted", ownerId: null } });
    this.stop();
    await this.start();
    return link;
  }

  async disconnect() {
    if (this.credentials()?.mode === "hosted") await unlinkDevice();
    setSetting("telegram_pairing", null);
    saveConfig({ telegram: { ownerId: null } });
    this.stop();
    this.botName = null;
    await this.start();
  }

  ownerChat(): number | null {
    return loadConfig().telegram.ownerId;
  }

  private offsetKey = "telegram_offset";

  private setConnection(state: "connected" | "reconnecting" | "offline", retryInMs: number | null = null) {
    if (this.connection.state !== state || retryInMs !== null) this.connection = { state, since: this.connection.state === state ? this.connection.since : new Date().toISOString(), nextRetryAt: retryInMs === null ? null : new Date(Date.now() + retryInMs).toISOString() };
  }

  async start() {
    const credentials = this.credentials();
    if (!credentials || this.running) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    registerSecret(credentials.token);
    this.api = new TelegramApi(credentials.token, credentials.base);
    this.offsetKey = credentials.mode === "hosted" ? "telegram_offset_hosted" : "telegram_offset";
    try {
      this.botName = (await this.api.getMe()).username;
    } catch (error) {
      this.lastError = credentials.mode === "hosted" ? `Meadow bot relay unavailable: ${redact((error as Error).message)}` : `Telegram unavailable: ${redact((error as Error).message)}`;
      const rejected = /401|Unauthorized|Not Found|404/.test((error as Error).message);
      if (rejected) {
        console.warn(`[meadow] ${this.lastError}`);
        this.setConnection("offline");
        return;
      }
      const wait = backoffMs(this.failures++);
      this.setConnection("reconnecting", wait);
      this.retryTimer = setTimeout(() => void this.start(), wait);
      this.retryTimer.unref?.();
      return;
    }
    this.failures = 0;
    this.setConnection("connected");
    this.running = true;
    console.log(`[meadow] Telegram bot @${this.botName} connected (${credentials.mode === "hosted" ? "Meadow relay" : "long polling"})`);
    void this.poll(++this.generation);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setConnection("offline");
  }

  /** Self-repair hook: restart the channel if it should be connected but isn't. */
  async repair(): Promise<boolean> {
    if (!this.credentials()) return false;
    if (this.running && this.connection.state === "connected") return true;
    this.stop();
    this.failures = 0;
    await this.start();
    return this.running;
  }

  private async poll(generation: number) {
    let offset = Number(setting(this.offsetKey) ?? 0);
    while (this.running && this.api && generation === this.generation) {
      try {
        const updates = await this.api.getUpdates(offset);
        this.lastError = null;
        this.failures = 0;
        this.setConnection("connected");
        if (generation !== this.generation) return;
        for (const update of updates) {
          offset = update.update_id + 1;
          setSetting(this.offsetKey, String(offset));
          this.handle(update).catch(error => console.warn("[meadow] telegram handler error", redact((error as Error).message)));
        }
      } catch (error) {
        this.lastError = redact((error as Error).message);
        const wait = backoffMs(this.failures++);
        this.setConnection("reconnecting", wait);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }

  private isOwner(fromId: number | undefined, chatType?: string) {
    const owner = loadConfig().telegram.ownerId;
    return owner !== null && fromId === owner && (chatType === undefined || chatType === "private");
  }

  private async handle(update: TgUpdate) {
    const api = this.api!;
    if (update.callback_query) {
      const query = update.callback_query;
      if (!this.isOwner(query.from.id)) return;
      await api.answerCallback(query.id);
      if (query.message) await api.clearButtons(query.message.chat.id, query.message.message_id);
      const reply = await handleAction(CHANNEL, String(query.from.id), query.data ?? "", `telegram:${query.from.username ?? query.from.id}`);
      await this.send(query.from.id, reply);
      return;
    }
    const message = update.message;
    if (!message?.from) return;
    if (loadConfig().telegram.ownerId === null) {
      if (message.chat.type === "private" && message.text && consumePairingCode(message.text)) {
        saveConfig({ telegram: { ownerId: message.from.id } });
        await api.sendMessage(message.chat.id, "Paired. This Telegram account now controls Meadow on your computer. Turn on two-step verification in Telegram settings: this account is effectively the keys to your machine.\n\nSend /help to see what I can do, or just describe a project.");
      }
      return;
    }
    if (!this.isOwner(message.from.id, message.chat.type)) return;
    const chatId = message.chat.id;

    let text = message.text ?? "";
    const audio = message.voice ?? message.audio;
    if (audio) {
      try {
        const file = await api.downloadFile(audio.file_id);
        text = await transcribe(file.data, file.name || "voice.ogg");
      } catch (error) {
        await api.sendMessage(chatId, `I couldn't transcribe that voice note: ${redact((error as Error).message)}`);
        return;
      }
      if (!text) {
        await api.sendMessage(chatId, "I couldn't hear anything in that voice note.");
        return;
      }
      await api.sendMessage(chatId, `Heard: "${text}"`);
    } else if (message.document) {
      const name = message.document.file_name ?? "";
      if ((message.document.file_size ?? 0) > 20 * 1024 * 1024) {
        await api.sendMessage(chatId, "That file is larger than 20 MB. Send a shorter plan or spec.");
        return;
      }
      if (!/\.(md|markdown|txt|ya?ml)$/i.test(name)) {
        await this.send(chatId, await handleDocument(CHANNEL, String(message.from.id), { name, data: Buffer.alloc(0), caption: message.caption }));
        return;
      }
      let data: Buffer;
      try {
        data = (await api.downloadFile(message.document.file_id)).data;
      } catch (error) {
        await api.sendMessage(chatId, `I couldn't download ${name || "that file"}: ${redact((error as Error).message)}`);
        return;
      }
      await this.send(chatId, await handleDocument(CHANNEL, String(message.from.id), { name, data, caption: message.caption }));
      return;
    } else if (message.photo) {
      await api.sendMessage(chatId, "I can't read images yet. Type the idea, or send a PLAN.md or SPEC.md file.");
      return;
    }
    if (!text) return;
    const reply = await handleText(CHANNEL, String(message.from.id), text);
    await this.send(chatId, reply);
    if (/^\/status\b/.test(text) && loadConfig().telegram.voiceReplies) {
      const ogg = await speak(reply.text).catch(() => null);
      if (ogg) await api.sendVoice(chatId, ogg).catch(() => null);
    }
  }

  async send(chatId: number, reply: Reply) {
    const api = this.api;
    if (!api) return;
    const toInline = (rows: Reply["buttons"]): InlineButton[][] | undefined => rows?.map(row => row.map(button => ({ text: button.label, callback_data: button.action.slice(0, 64) })));
    const sent = await api.sendMessage(chatId, redact(reply.text), toInline(reply.buttons));
    if (reply.investigate) await this.liveInvestigation(chatId, sent.message_id, reply.investigate, toInline);
    if (reply.shot) {
      try {
        const { shots, skipped } = await captureOnDemand(reply.shot.projectId, reply.shot.route);
        if (shots.length) await api.sendPhotos(chatId, shots.map(shot => ({ path: shot.path, caption: shot.label })));
        if (skipped.length) await api.sendMessage(chatId, redact(skipped.join("\n")));
      } catch (error) {
        await api.sendMessage(chatId, `Screenshot failed: ${redact((error as Error).message)}`);
      }
    }
  }

  /** Edits one message in place with the agent trace, then posts the cited answer with action buttons. */
  private async liveInvestigation(chatId: number, messageId: number, job: { projectId: number; question: string }, toInline: (rows: Reply["buttons"]) => InlineButton[][] | undefined) {
    const api = this.api!;
    let pending: string | null = null;
    let lastEdit = 0;
    let timer: NodeJS.Timeout | null = null;
    let chain: Promise<unknown> = Promise.resolve();
    const flush = () => {
      timer = null;
      if (pending === null) return;
      const text = redact(pending);
      pending = null;
      lastEdit = Date.now();
      chain = chain.then(() => api.editMessage(chatId, messageId, text)).catch(() => null);
    };
    const onProgress = (card: string) => {
      pending = card;
      if (!timer) timer = setTimeout(flush, Math.max(0, 2000 - (Date.now() - lastEdit)));
    };
    try {
      const answer = await chatInvestigate(job.projectId, job.question, "telegram", onProgress);
      if (timer) clearTimeout(timer);
      pending = null;
      await chain;
      await api.editMessage(chatId, messageId, `🔍 Investigation finished: ${job.question.slice(0, 200)}`).catch(() => null);
      await api.sendMessage(chatId, answer.text, toInline(answer.buttons));
    } catch (error) {
      if (timer) clearTimeout(timer);
      await api.sendMessage(chatId, `Investigation failed: ${redact((error as Error).message)}`);
    }
  }

  async sendStatus(projectId: number) {
    const owner = this.ownerChat();
    if (owner && this.api) await this.api.sendMessage(owner, redact(statusText(projectId)));
  }
}

export const telegram = new TelegramChannel();
