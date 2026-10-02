import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatEvent, wantsEvent } from "../../server/meadow/channels/notifier";
import { createPairingCode, TelegramChannel } from "../../server/meadow/channels/telegram";
import { loadConfig, resetConfigCache, saveConfig } from "../../server/meadow/config";
import type { MeadowEvent } from "../../server/meadow/core/events";
import { tempHome } from "../helpers";

type Sent = { method: string; body: Record<string, unknown> };

/** Mock Telegram Bot API: queued updates are returned once by getUpdates; outgoing calls are recorded. */
function mockTelegram(updates: unknown[]) {
  const sent: Sent[] = [];
  let served = false;
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    const method = url.split("/").pop()!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "meadow_test_bot" } }));
    if (method === "getUpdates") {
      if (!served) {
        served = true;
        return new Response(JSON.stringify({ ok: true, result: updates }));
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
  return sent;
}

const message = (fromId: number, text: string, updateId: number) => ({ update_id: updateId, message: { message_id: updateId, from: { id: fromId }, chat: { id: fromId, type: "private" }, text } });

let env: ReturnType<typeof tempHome>;
let channel: TelegramChannel;

beforeEach(() => {
  env = tempHome();
  process.env.TELEGRAM_BOT_TOKEN = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz0";
  channel = new TelegramChannel();
});

afterEach(() => {
  channel.stop();
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_BOT_TOKEN;
  env.cleanup();
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 30));
};

describe("telegram pairing and owner guard", () => {
  it("binds the first account that sends the code and ignores everyone else", async () => {
    const code = createPairingCode();
    const sent = mockTelegram([message(999, "hello", 1), message(42, "000000", 2), message(42, code, 3), message(999, code, 4), message(999, "/status", 5), message(42, "/help", 6)]);
    await channel.start();
    await until(() => sent.filter(item => item.method === "sendMessage").length >= 2);
    resetConfigCache();
    expect(loadConfig().telegram.ownerId).toBe(42);
    const messages = sent.filter(item => item.method === "sendMessage");
    expect(messages.every(item => item.body.chat_id === 42)).toBe(true);
    expect(String(messages[0].body.text)).toMatch(/Paired/);
    expect(String(messages[1].body.text)).toMatch(/Commands:/);
  });

  it("gives a stranger no response at all once paired", async () => {
    saveConfig({ telegram: { ownerId: 42 } });
    const sent = mockTelegram([message(7, "/help", 1), message(7, "make me a site", 2), { update_id: 3, callback_query: { id: "c", from: { id: 7 }, data: "stop:1" } }]);
    await channel.start();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(sent).toEqual([]);
  });

  it("never sends the bot token in messages", async () => {
    saveConfig({ telegram: { ownerId: 42 } });
    const sent = mockTelegram([message(42, "/remember token is 123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz0", 1)]);
    await channel.start();
    await until(() => sent.length > 0);
    expect(JSON.stringify(sent)).not.toContain("TEST_TOKEN_abcdefghijklmnopqrstuvwxyz0");
  });
});

const event = (type: MeadowEvent["type"], payload: Record<string, unknown> = {}, extra: Partial<MeadowEvent> = {}): MeadowEvent => ({ id: 1, projectId: 1, executionId: 1, runId: null, phaseId: 1, ts: new Date().toISOString(), type, title: "Phase 2 of 5 passed: Menu and cart", detail: "Built the menu.", payload, ...extra });

describe("notification cards", () => {
  it("formats the phase-end card", () => {
    const card = formatEvent(event("phase_passed", { checks: ["npm run build", "npm test"], files: 9, additions: 312, deletions: 18, dependencyChanges: [] }))!;
    expect(card.text).toContain("Phase 2 of 5 passed: Menu and cart");
    expect(card.text).toContain("Changed: 9 files (+312 −18)");
    expect(card.text).toContain("New dependencies: none");
    expect(card.buttons!.flat().map(button => button.text)).toEqual(expect.arrayContaining(["Retry", "Pause", "Add feature"]));
  });

  it("formats the blocked card with recovery buttons", () => {
    const card = formatEvent(event("phase_blocked", { failing: "npm test -- checkout" }, { title: "Phase 3 is stuck after 3 attempts: Checkout", detail: "Failing: npm test -- checkout (exit 1)" }))!;
    expect(card.urgent).toBe(true);
    expect(card.buttons!.flat().map(button => button.text)).toEqual(["Retry with hint", "Retry", "Skip phase", "Roll back", "Stop"]);
  });

  it("formats approval cards that default to deny", () => {
    const card = formatEvent(event("approval_requested", { approvalId: 5, risk: "high", expiresInS: 1800 }, { title: "Delete 30 files?" }))!;
    expect(card.text).toMatch(/defaults to Deny/);
    expect(card.buttons![0].map(button => button.callback_data)).toEqual(["approval:5:yes", "approval:5:no"]);
  });

  it("respects notification levels", () => {
    saveConfig({ telegram: { notificationLevel: "failures" } });
    expect(wantsEvent(event("phase_passed"))).toBe(false);
    expect(wantsEvent(event("phase_blocked"))).toBe(true);
    saveConfig({ telegram: { notificationLevel: "phases" } });
    expect(wantsEvent(event("phase_passed"))).toBe(true);
    expect(wantsEvent(event("file_edit"))).toBe(false);
    saveConfig({ telegram: { notificationLevel: "all" } });
    expect(wantsEvent(event("file_edit"))).toBe(true);
  });
});
