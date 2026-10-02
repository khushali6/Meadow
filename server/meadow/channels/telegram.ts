import crypto from "node:crypto";
import { getSecret, loadConfig, saveConfig } from "../config";
import { getDb } from "../core/db";
import { redact, registerSecret } from "../core/redact";
import { handleAction, handleText, type Reply } from "../intake/conversation";
import { statusText } from "../service";
import { captureOnDemand } from "../visual/ondemand";
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

/** One-time pairing code, valid for 15 minutes. The first Telegram user to send it becomes the owner. */
export function createPairingCode(): string {
  const code = crypto.randomInt(100000, 999999).toString();
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
  const candidate = text.replace(/^\/(start|pair)\s*/, "").trim();
  if (!/^\d{6}$/.test(candidate)) return false;
  const ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(crypto.createHash("sha256").update(candidate).digest("hex")));
  if (ok) setSetting("telegram_pairing", null);
  return ok;
}

export class TelegramChannel {
  api: TelegramApi | null = null;
  private running = false;
  private generation = 0;
  private botName: string | null = null;
  lastError: string | null = null;

  status() {
    const config = loadConfig().telegram;
    return { configured: Boolean(getSecret("TELEGRAM_BOT_TOKEN")), running: this.running, bot: this.botName, paired: config.ownerId !== null, pairingPending: Boolean(setting("telegram_pairing")), lastError: this.lastError };
  }

  ownerChat(): number | null {
    return loadConfig().telegram.ownerId;
  }

  async start() {
    const token = getSecret("TELEGRAM_BOT_TOKEN");
    if (!token || this.running) return;
    registerSecret(token);
    this.api = new TelegramApi(token);
    try {
      this.botName = (await this.api.getMe()).username;
    } catch (error) {
      this.lastError = `Telegram token rejected: ${(error as Error).message}`;
      console.warn(`[meadow] ${this.lastError}`);
      return;
    }
    this.running = true;
    console.log(`[meadow] Telegram bot @${this.botName} connected (long polling)`);
    void this.poll(++this.generation);
  }

  stop() {
    this.running = false;
    this.generation += 1;
  }

  private async poll(generation: number) {
    let offset = Number(setting("telegram_offset") ?? 0);
    while (this.running && this.api && generation === this.generation) {
      try {
        const updates = await this.api.getUpdates(offset);
        this.lastError = null;
        if (generation !== this.generation) return;
        for (const update of updates) {
          offset = update.update_id + 1;
          setSetting("telegram_offset", String(offset));
          this.handle(update).catch(error => console.warn("[meadow] telegram handler error", redact((error as Error).message)));
        }
      } catch (error) {
        this.lastError = redact((error as Error).message);
        await new Promise(resolve => setTimeout(resolve, 5000));
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
      if (!/\.(md|markdown|txt|ya?ml)$/i.test(name)) {
        await api.sendMessage(chatId, "Send a PLAN.md (Markdown with YAML front-matter) to import a plan.");
        return;
      }
      text = (await api.downloadFile(message.document.file_id)).data.toString("utf8");
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
    const buttons: InlineButton[][] | undefined = reply.buttons?.map(row => row.map(button => ({ text: button.label, callback_data: button.action.slice(0, 64) })));
    await api.sendMessage(chatId, redact(reply.text), buttons);
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

  async sendStatus(projectId: number) {
    const owner = this.ownerChat();
    if (owner && this.api) await this.api.sendMessage(owner, redact(statusText(projectId)));
  }
}

export const telegram = new TelegramChannel();
