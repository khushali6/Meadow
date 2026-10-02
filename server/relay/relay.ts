import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/**
 * The Meadow Telegram relay. One bot (yours) serves every Meadow install:
 * - Telegram updates are polled here with the bot token, which never leaves this process.
 * - Each install gets a device token and talks to `/bot<deviceToken>/<method>`, the same shape
 *   as the Bot API, so the daemon's Telegram client works unchanged.
 * - A chat is bound to a device only through a one-time deep link (`t.me/<bot>?start=<code>`)
 *   the daemon requested. A device can only read updates from, and send to, its own chat.
 * - Message contents pass through memory only; nothing but device bindings is written to disk.
 */

export type RelayOptions = {
  botToken: string;
  telegramBase?: string;
  dataFile?: string | null;
  linkTtlMs?: number;
  pollTimeoutS?: number;
  log?: (message: string) => void;
};

type Device = { hash: string; chatId: number | null; userId: number | null; createdAt: number; lastSeen: number };
type Live = { queue: Array<Record<string, unknown> & { update_id: number }>; seq: number; waiters: Set<() => void>; callbacks: Set<string>; files: Set<string>; paths: Set<string> };
type TgReply = { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: Record<string, unknown> };
type IncomingUpdate = {
  update_id: number;
  message?: { from?: { id: number }; chat: { id: number; type: string }; text?: string; voice?: { file_id: string }; audio?: { file_id: string }; document?: { file_id: string }; photo?: Array<{ file_id: string }> };
  callback_query?: { id: string; from: { id: number }; message?: { chat: { id: number } } };
};

export const LINK_CODE = /^[A-Za-z0-9_-]{24,64}$/;
const JSON_METHODS = new Set(["sendMessage", "editMessageText", "editMessageReplyMarkup", "sendChatAction", "deleteMessage"]);
const FORM_METHODS = new Set(["sendPhoto", "sendMediaGroup", "sendVoice", "sendDocument"]);
const MAX_JSON = 64 * 1024;
const MAX_FORM = 25 * 1024 * 1024;
const QUEUE_CAP = 500;

const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (code: number, description: string): TgReply => ({ ok: false, error_code: code, description });

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function createRelay(options: RelayOptions) {
  const base = (options.telegramBase ?? "https://api.telegram.org").replace(/\/$/, "");
  const linkTtl = options.linkTtlMs ?? 15 * 60_000;
  const pollTimeout = options.pollTimeoutS ?? 25;
  const log = options.log ?? (message => console.log(`[relay] ${message}`));
  const devices = new Map<string, Device>();
  const live = new Map<string, Live>();
  const pending = new Map<string, { hash: string; expires: number }>();
  const linkHits = new Map<string, number[]>();
  const hinted = new Map<number, number>();
  let bot: { id: number; username: string } | null = null;
  let running = false;
  let pollAbort: AbortController | null = null;

  if (options.dataFile && fs.existsSync(options.dataFile)) {
    const saved = JSON.parse(fs.readFileSync(options.dataFile, "utf8")) as { devices?: Device[] };
    for (const device of saved.devices ?? []) devices.set(device.hash, device);
  }
  const save = () => {
    if (!options.dataFile) return;
    fs.mkdirSync(path.dirname(options.dataFile), { recursive: true });
    const tmp = `${options.dataFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ devices: Array.from(devices.values()) }), { mode: 0o600 });
    fs.renameSync(tmp, options.dataFile);
  };

  async function tg(method: string, body: Record<string, unknown> | FormData, timeoutMs = 30_000, signal?: AbortSignal): Promise<TgReply> {
    const isForm = body instanceof FormData;
    const response = await fetch(`${base}/bot${options.botToken}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    return (await response.json()) as TgReply;
  }

  const liveOf = (hash: string): Live => {
    let entry = live.get(hash);
    if (!entry) live.set(hash, (entry = { queue: [], seq: 0, waiters: new Set(), callbacks: new Set(), files: new Set(), paths: new Set() }));
    return entry;
  };
  const deviceForChat = (chatId: number) => Array.from(devices.values()).find(device => device.chatId === chatId) ?? null;

  function enqueue(hash: string, update: IncomingUpdate) {
    const entry = liveOf(hash);
    const message = update.message;
    for (const file of [message?.voice, message?.audio, message?.document, ...(message?.photo ?? [])]) if (file) entry.files.add(file.file_id);
    if (update.callback_query) entry.callbacks.add(update.callback_query.id);
    entry.seq += 1;
    entry.queue.push({ ...(update as unknown as Record<string, unknown>), update_id: entry.seq });
    if (entry.queue.length > QUEUE_CAP) entry.queue.splice(0, entry.queue.length - QUEUE_CAP);
    for (const wake of entry.waiters) wake();
    entry.waiters.clear();
  }

  const say = (chatId: number, text: string) => tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }).catch(() => null);

  async function route(update: IncomingUpdate) {
    const message = update.message;
    const query = update.callback_query;
    const chatId = message?.chat.id ?? query?.message?.chat.id ?? query?.from.id;
    if (chatId === undefined) return;
    const start = message?.chat.type === "private" && message.from ? (message.text ?? "").match(/^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/) : null;
    if (start && message?.from) {
      const code = start[1] ?? "";
      const link = LINK_CODE.test(code) ? pending.get(code) : undefined;
      const device = link && link.expires > Date.now() ? devices.get(link.hash) : undefined;
      if (link && device) {
        pending.delete(code);
        for (const other of devices.values()) if (other.chatId === chatId && other.hash !== device.hash) Object.assign(other, { chatId: null, userId: null });
        Object.assign(device, { chatId, userId: message.from.id });
        save();
        enqueue(device.hash, update);
        log(`chat linked to a device (${devices.size} devices)`);
        return;
      }
      if (code || !deviceForChat(chatId)) {
        await say(chatId, code ? "That connect link has expired or was already used. In Meadow, open Runtime settings → Telegram and click Connect Telegram again." : "Hi! I'm the Meadow bot. To connect, open Meadow on your computer, go to Runtime settings → Telegram and click Connect Telegram.");
        return;
      }
    }
    const device = deviceForChat(chatId);
    if (!device) {
      if (message?.chat.type === "private" && (hinted.get(chatId) ?? 0) < Date.now() - 60_000) {
        hinted.set(chatId, Date.now());
        await say(chatId, "This chat isn't connected to a Meadow yet. Open Meadow → Runtime settings → Telegram → Connect Telegram.");
      }
      return;
    }
    enqueue(device.hash, update);
  }

  async function poll() {
    let offset = 0;
    await tg("deleteWebhook", {}).catch(() => null);
    while (running) {
      try {
        pollAbort = new AbortController();
        const reply = await tg("getUpdates", { offset, timeout: pollTimeout, allowed_updates: ["message", "callback_query"] }, (pollTimeout + 10) * 1000, pollAbort.signal);
        if (!reply.ok) throw new Error(reply.description ?? "getUpdates failed");
        for (const update of reply.result as IncomingUpdate[]) {
          offset = update.update_id + 1;
          await route(update).catch(error => log(`route error: ${(error as Error).message}`));
        }
      } catch (error) {
        if (!running) return;
        log(`poll error: ${(error as Error).message}`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  function authorize(token: string | undefined): Device {
    const device = token ? devices.get(sha(token)) : undefined;
    if (!device) throw new HttpError(401, "Unknown device token");
    device.lastSeen = Date.now();
    return device;
  }

  function rateLimited(ip: string): boolean {
    const now = Date.now();
    const hits = (linkHits.get(ip) ?? []).filter(at => at > now - 10 * 60_000);
    hits.push(now);
    linkHits.set(ip, hits);
    return hits.length > 20;
  }

  async function link(req: http.IncomingMessage) {
    if (rateLimited(req.socket.remoteAddress ?? "?")) throw new HttpError(429, "Too many connect attempts. Try again in a few minutes.");
    const body = JSON.parse((await readBody(req, MAX_JSON)).toString("utf8") || "{}") as { code?: unknown };
    if (typeof body.code !== "string" || !LINK_CODE.test(body.code)) throw new HttpError(400, "A link code of 24 to 64 URL-safe characters is required");
    if (!bot) throw new HttpError(503, "The relay hasn't reached Telegram yet");
    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
    let device: Device;
    let deviceToken: string | undefined;
    if (bearer) device = authorize(bearer);
    else {
      deviceToken = crypto.randomBytes(32).toString("base64url");
      device = { hash: sha(deviceToken), chatId: null, userId: null, createdAt: Date.now(), lastSeen: Date.now() };
      devices.set(device.hash, device);
      save();
    }
    for (const [code, entry] of pending) if (entry.hash === device.hash || entry.expires < Date.now()) pending.delete(code);
    const expires = Date.now() + linkTtl;
    pending.set(body.code, { hash: device.hash, expires });
    return { ...(deviceToken ? { deviceToken } : {}), bot: bot.username, link: `https://t.me/${bot.username}?start=${body.code}`, expiresAt: new Date(expires).toISOString() };
  }

  async function botMethod(req: http.IncomingMessage, device: Device, method: string): Promise<TgReply> {
    const entry = liveOf(device.hash);
    if (method === "getMe") return { ok: true, result: bot };
    if (method === "getUpdates") {
      const body = JSON.parse((await readBody(req, MAX_JSON)).toString("utf8") || "{}") as { offset?: number; timeout?: number };
      const offset = Number(body.offset ?? 0);
      entry.queue = entry.queue.filter(update => update.update_id >= offset);
      if (!entry.queue.length) {
        const wait = Math.max(0, Math.min(Number(body.timeout ?? 0), 25)) * 1000;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            entry.waiters.delete(done);
            resolve();
          }, wait);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          entry.waiters.add(done);
          req.on("close", done);
        });
      }
      return { ok: true, result: entry.queue.slice(0, 100) };
    }
    if (device.chatId === null) return fail(403, "Forbidden: this Meadow isn't connected to a chat yet");
    if (JSON_METHODS.has(method) || method === "answerCallbackQuery" || method === "getFile") {
      const body = JSON.parse((await readBody(req, MAX_JSON)).toString("utf8") || "{}") as Record<string, unknown>;
      if (method === "answerCallbackQuery") {
        if (!entry.callbacks.has(String(body.callback_query_id))) return fail(403, "Forbidden: unknown callback");
        entry.callbacks.delete(String(body.callback_query_id));
        return tg(method, body);
      }
      if (method === "getFile") {
        if (!entry.files.has(String(body.file_id))) return fail(403, "Forbidden: unknown file");
        const reply = await tg(method, { file_id: body.file_id });
        const filePath = (reply.result as { file_path?: string } | undefined)?.file_path;
        if (reply.ok && filePath) entry.paths.add(filePath);
        return reply;
      }
      if (Number(body.chat_id) !== device.chatId) return fail(403, "Forbidden: a device can only message its own chat");
      return tg(method, body);
    }
    if (FORM_METHODS.has(method)) {
      const raw = await readBody(req, MAX_FORM);
      const form = await new Request("http://relay.local/", { method: "POST", headers: { "content-type": String(req.headers["content-type"] ?? "") }, body: new Uint8Array(raw) }).formData();
      if (Number(form.get("chat_id")) !== device.chatId) return fail(403, "Forbidden: a device can only message its own chat");
      return tg(method, form, 60_000);
    }
    return fail(403, `Forbidden: ${method} is not available through the Meadow relay`);
  }

  async function proxyFile(res: http.ServerResponse, device: Device, filePath: string) {
    const entry = liveOf(device.hash);
    if (!entry.paths.has(filePath)) throw new HttpError(403, "Unknown file");
    entry.paths.delete(filePath);
    const response = await fetch(`${base}/file/bot${options.botToken}/${filePath}`, { signal: AbortSignal.timeout(60_000) });
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay.local");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, bot: bot?.username ?? null, devices: devices.size });
      if (req.method === "POST" && url.pathname === "/v1/link") return send(res, 200, await link(req));
      if (req.method === "POST" && url.pathname === "/v1/unlink") {
        const device = authorize(req.headers.authorization?.match(/^Bearer\s+(\S+)$/)?.[1]);
        devices.delete(device.hash);
        live.delete(device.hash);
        save();
        return send(res, 200, { ok: true });
      }
      const file = url.pathname.match(/^\/file\/bot([A-Za-z0-9_-]+)\/(.+)$/);
      if (req.method === "GET" && file) return await proxyFile(res, authorize(file[1]), decodeURIComponent(file[2]));
      const call = url.pathname.match(/^\/bot([A-Za-z0-9_-]+)\/([A-Za-z]+)$/);
      if (req.method === "POST" && call) {
        const device = devices.get(sha(call[1]));
        if (!device) return send(res, 401, fail(401, "Unauthorized: unknown device token"));
        device.lastSeen = Date.now();
        return send(res, 200, await botMethod(req, device, call[2]));
      }
      send(res, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
      if (status === 500) log(`error: ${(error as Error).message}`);
      send(res, status, { ok: false, error_code: status, description: status === 500 ? "Relay error" : (error as Error).message, error: status === 500 ? "Relay error" : (error as Error).message });
    }
  });

  return {
    server,
    devices,
    async start() {
      const me = await tg("getMe", {});
      if (!me.ok) throw new Error(`Telegram rejected the bot token: ${me.description ?? "unknown error"}`);
      bot = me.result as { id: number; username: string };
      running = true;
      void poll();
      return bot;
    },
    stop() {
      running = false;
      pollAbort?.abort();
      for (const entry of live.values()) for (const wake of entry.waiters) wake();
      server.closeAllConnections?.();
      server.close();
    },
  };
}
