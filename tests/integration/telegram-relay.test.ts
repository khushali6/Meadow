import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRelayUrl } from "../../server/meadow/channels/relay";
import { telegram } from "../../server/meadow/channels/telegram";
import { TelegramApi } from "../../server/meadow/channels/telegramApi";
import { getSecret, loadConfig, saveConfig } from "../../server/meadow/config";
import { createRelay } from "../../server/relay/relay";
import { tempHome } from "../helpers";

const BOT_TOKEN = "123456:REAL-BOT-TOKEN-never-leaves-relay";

/** A tiny stand-in for api.telegram.org that records what was sent and lets tests inject updates. */
function mockTelegram() {
  const updates: Array<Record<string, unknown>> = [];
  const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  let nextId = 1;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const match = req.url?.match(/^\/bot([^/]+)\/(\w+)$/);
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (!match || match[1] !== BOT_TOKEN) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
    }
    const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : {};
    const method = match[2];
    if (method === "getMe") return reply({ id: 999, username: "meadow_test_bot" });
    if (method === "deleteWebhook") return reply(true);
    if (method === "getUpdates") {
      const offset = Number(body.offset ?? 0);
      const deadline = Date.now() + 300;
      while (Date.now() < deadline && !updates.some(update => Number(update.update_id) >= offset)) await new Promise(resolve => setTimeout(resolve, 20));
      return reply(updates.filter(update => Number(update.update_id) >= offset));
    }
    sent.push({ method, body });
    return reply({ message_id: sent.length });
  });
  return {
    server,
    sent,
    push(update: Record<string, unknown>) {
      updates.push({ update_id: nextId++, ...update });
    },
    message(chatId: number, text: string) {
      this.push({ message: { message_id: nextId, from: { id: chatId, username: `user${chatId}` }, chat: { id: chatId, type: "private" }, text } });
    },
  };
}

async function waitFor(check: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const listen = (server: http.Server) => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

let env: ReturnType<typeof tempHome>;
let tg: ReturnType<typeof mockTelegram>;
let relay: ReturnType<typeof createRelay>;
let relayBase: string;
let linkCode = "";

const relayCall = async (path: string, body: unknown, token?: string) => {
  const response = await fetch(`${relayBase}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, data: (await response.json()) as Record<string, any> };
};

beforeAll(async () => {
  env = tempHome();
  tg = mockTelegram();
  const tgBase = await listen(tg.server);
  relay = createRelay({ botToken: BOT_TOKEN, telegramBase: tgBase, dataFile: null, pollTimeoutS: 1, log: () => {} });
  await relay.start();
  relayBase = await listen(relay.server);
  saveConfig({ telegram: { relayUrl: relayBase } });
});

afterAll(() => {
  telegram.stop();
  relay.stop();
  tg.server.closeAllConnections();
  tg.server.close();
  env.cleanup();
});

describe("one-click Telegram connect through the Meadow relay", () => {
  it("connects with a deep link and pairs when the user taps Start", async () => {
    expect(telegram.status()).toMatchObject({ configured: false, hostedAvailable: true });
    const link = await telegram.connectHosted();
    expect(link.bot).toBe("meadow_test_bot");
    expect(link.link).toMatch(/^https:\/\/t\.me\/meadow_test_bot\?start=[A-Za-z0-9_-]{24}$/);
    linkCode = link.link.split("start=")[1];
    expect(getSecret("TELEGRAM_RELAY_TOKEN")).toBeTruthy();
    expect(telegram.status()).toMatchObject({ configured: true, mode: "hosted", running: true, paired: false, bot: "meadow_test_bot" });

    tg.message(42, `/start ${linkCode}`);
    await waitFor(() => loadConfig().telegram.ownerId === 42);
    await waitFor(() => tg.sent.some(item => item.method === "sendMessage" && item.body.chat_id === 42 && /Paired/.test(String(item.body.text))));
    expect(telegram.status().paired).toBe(true);
  });

  it("delivers the owner's messages and replies to the same chat", async () => {
    const before = tg.sent.length;
    tg.message(42, "/help");
    await waitFor(() => tg.sent.slice(before).some(item => item.method === "sendMessage" && item.body.chat_id === 42));
  });

  it("forwards screenshots (multipart) only to the device's own chat", async () => {
    const file = path.join(env.root, "shot.png");
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const api = new TelegramApi(getSecret("TELEGRAM_RELAY_TOKEN")!, relayBase);
    await api.sendPhotos(42, [{ path: file, caption: "Home page" }]);
    expect(tg.sent.some(item => item.method === "sendPhoto")).toBe(true);
    await expect(api.sendPhotos(7, [{ path: file, caption: "x" }])).rejects.toThrow(/own chat/);
  });

  it("never stores or returns the bot token, and stores only a hash of device tokens", () => {
    const device = getSecret("TELEGRAM_RELAY_TOKEN")!;
    const stored = JSON.stringify(Array.from(relay.devices.values()));
    expect(stored).not.toContain(device);
    expect(stored).not.toContain(BOT_TOKEN);
    expect(device).not.toContain(BOT_TOKEN.split(":")[1]);
  });

  it("keeps devices apart: another install can't read or message someone else's chat", async () => {
    const other = await relayCall("/v1/link", { code: "x".repeat(24) });
    expect(other.status).toBe(200);
    const token = other.data.deviceToken as string;
    const send = await relayCall(`/bot${token}/sendMessage`, { chat_id: 42, text: "hijack" });
    expect(send.data).toMatchObject({ ok: false, error_code: 403 });
    tg.message(42, "/status");
    const updates = await relayCall(`/bot${token}/getUpdates`, { offset: 0, timeout: 0 });
    expect(updates.data.result).toEqual([]);
  });

  it("refuses unknown tokens, unknown files and methods outside the allowlist", async () => {
    expect((await relayCall("/botnot-a-device/getMe", {})).status).toBe(401);
    const device = getSecret("TELEGRAM_RELAY_TOKEN")!;
    expect((await relayCall(`/bot${device}/getFile`, { file_id: "someone-elses-file" })).data.error_code).toBe(403);
    expect((await relayCall(`/bot${device}/setWebhook`, { url: "https://evil.example" })).data.error_code).toBe(403);
    expect((await relayCall("/v1/link", { code: "short" })).status).toBe(400);
  });

  it("answers strangers and reused links itself without reaching any Meadow", async () => {
    const before = tg.sent.length;
    tg.message(77, `/start ${linkCode}`);
    tg.message(99, "hello");
    await waitFor(() => tg.sent.slice(before).filter(item => item.body.chat_id === 77 || item.body.chat_id === 99).length >= 2);
    expect(tg.sent.find(item => item.body.chat_id === 77)?.body.text).toMatch(/expired or was already used/);
    expect(tg.sent.find(item => item.body.chat_id === 99)?.body.text).toMatch(/isn't connected/);
    expect(loadConfig().telegram.ownerId).toBe(42);
  });

  it("reconnects with backoff after a network failure, without pairing again", async () => {
    const dead = http.createServer();
    const deadBase = await listen(dead);
    await new Promise(resolve => dead.close(resolve));
    telegram.stop();
    saveConfig({ telegram: { relayUrl: deadBase } });
    await telegram.start();
    expect(telegram.status()).toMatchObject({ running: false, paired: true, connection: { state: "reconnecting", nextRetryAt: expect.any(String) } });
    saveConfig({ telegram: { relayUrl: relayBase } });
    await waitFor(() => telegram.status().connection.state === "connected", 5000);
    expect(telegram.status()).toMatchObject({ running: true, paired: true });
    expect(loadConfig().telegram.ownerId).toBe(42);
    const before = tg.sent.length;
    tg.message(42, "/help");
    await waitFor(() => tg.sent.slice(before).some(item => item.method === "sendMessage" && item.body.chat_id === 42));
  });

  it("disconnects: the relay forgets the device and the owner is cleared", async () => {
    const devicesBefore = relay.devices.size;
    await telegram.disconnect();
    expect(getSecret("TELEGRAM_RELAY_TOKEN")).toBeUndefined();
    expect(loadConfig().telegram.ownerId).toBeNull();
    expect(relay.devices.size).toBe(devicesBefore - 1);
    expect(telegram.status()).toMatchObject({ configured: false, running: false });
  });

  it("only accepts HTTPS relays, or plain HTTP on localhost", () => {
    expect(checkRelayUrl("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(checkRelayUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => checkRelayUrl("http://relay.example.com")).toThrow(/HTTPS/);
    expect(() => checkRelayUrl("https://user:pw@relay.example.com")).toThrow(/credentials/);
  });
});
