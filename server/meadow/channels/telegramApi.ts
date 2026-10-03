import fs from "node:fs";
import path from "node:path";

export type InlineButton = { text: string; callback_data: string };

export type TgUpdate = {
  update_id: number;
  message?: { message_id: number; from?: { id: number; username?: string }; chat: { id: number; type: string }; text?: string; voice?: { file_id: string; duration: number }; audio?: { file_id: string }; document?: { file_id: string; file_name?: string; file_size?: number }; caption?: string; photo?: Array<{ file_id: string }> };
  callback_query?: { id: string; from: { id: number; username?: string }; data?: string; message?: { message_id: number; chat: { id: number } } };
};

export class TelegramError extends Error {
  constructor(message: string, readonly code?: number, readonly retryAfter?: number) {
    super(message);
  }
}

/** Network drops, timeouts and Telegram's own 5xx errors are worth retrying; rejections (400, 401, 403) are not. */
export function isTransient(error: unknown): boolean {
  if (error instanceof TelegramError) return (error.code ?? 0) >= 500;
  const err = error as { name?: string; message?: string; cause?: { code?: string } };
  return err?.name === "TimeoutError" || err?.name === "AbortError" || /fetch failed|network|socket|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE/i.test(`${err?.message ?? ""} ${err?.cause?.code ?? ""}`);
}

/** Minimal Telegram Bot API client over long polling: outbound HTTPS only, no open ports. */
export class TelegramApi {
  private lastSend = 0;

  constructor(private token: string, private base = "https://api.telegram.org", private retry = { attempts: 4, baseMs: 1000 }) {}

  private async call<T>(method: string, body?: Record<string, unknown> | FormData, timeoutMs = 30_000): Promise<T> {
    const isForm = body instanceof FormData;
    const response = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await response.json()) as { ok: boolean; result: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!data.ok) throw new TelegramError(data.description ?? `Telegram ${method} failed`, data.error_code, data.parameters?.retry_after);
    return data.result;
  }

  /** Keep under Telegram's ~1 msg/s per chat limit, honour retry_after, and ride out short network drops. */
  private async throttled<T>(fn: () => Promise<T>): Promise<T> {
    let rateLimited = 0;
    let dropped = 0;
    while (true) {
      const wait = this.lastSend + 1100 - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      this.lastSend = Date.now();
      try {
        return await fn();
      } catch (error) {
        if (error instanceof TelegramError && error.code === 429 && rateLimited++ < 4) {
          await new Promise(resolve => setTimeout(resolve, ((error.retryAfter ?? 3) + 1) * 1000));
          continue;
        }
        if (isTransient(error) && dropped++ < this.retry.attempts) {
          await new Promise(resolve => setTimeout(resolve, this.retry.baseMs * 2 ** (dropped - 1)));
          continue;
        }
        throw error;
      }
    }
  }

  getMe() {
    return this.call<{ id: number; username: string }>("getMe");
  }

  getUpdates(offset: number, timeoutS = 25) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutS, allowed_updates: ["message", "callback_query"] }, (timeoutS + 10) * 1000);
  }

  sendMessage(chatId: number, text: string, buttons?: InlineButton[][], options: { silent?: boolean } = {}) {
    return this.throttled(() => this.call<{ message_id: number }>("sendMessage", { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...(options.silent ? { disable_notification: true } : {}), ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}) }));
  }

  editMessage(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]) {
    return this.throttled(() => this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) })).catch(error => {
      if (error instanceof TelegramError && /not modified/.test(error.message)) return null;
      throw error;
    });
  }

  clearButtons(chatId: number, messageId: number) {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => null);
  }

  answerCallback(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => null);
  }

  async sendPhotos(chatId: number, photos: Array<{ path: string; caption: string }>) {
    for (let i = 0; i < photos.length; i += 10) {
      const group = photos.slice(i, i + 10);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (group.length === 1) {
        form.append("photo", new Blob([new Uint8Array(fs.readFileSync(group[0].path))]), path.basename(group[0].path));
        form.append("caption", group[0].caption.slice(0, 1000));
        await this.throttled(() => this.call("sendPhoto", form, 60_000));
        continue;
      }
      const media = group.map((photo, j) => ({ type: "photo", media: `attach://p${j}`, caption: photo.caption.slice(0, 1000) }));
      form.append("media", JSON.stringify(media));
      group.forEach((photo, j) => form.append(`p${j}`, new Blob([new Uint8Array(fs.readFileSync(photo.path))]), path.basename(photo.path)));
      await this.throttled(() => this.call("sendMediaGroup", form, 60_000));
    }
  }

  async sendVoice(chatId: number, oggPath: string) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("voice", new Blob([new Uint8Array(fs.readFileSync(oggPath))]), "status.ogg");
    await this.throttled(() => this.call("sendVoice", form, 60_000));
  }

  async downloadFile(fileId: string): Promise<{ data: Buffer; name: string }> {
    const file = await this.call<{ file_path: string; file_size?: number }>("getFile", { file_id: fileId });
    if ((file.file_size ?? 0) > 20 * 1024 * 1024) throw new TelegramError("File is larger than 20 MB");
    const response = await fetch(`${this.base}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    return { data: Buffer.from(await response.arrayBuffer()), name: path.basename(file.file_path) };
  }
}
