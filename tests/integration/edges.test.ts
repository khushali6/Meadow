import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier } from "../../server/meadow/channels/notifier";
import { isTransient, TelegramApi, TelegramError } from "../../server/meadow/channels/telegramApi";
import { saveConfig } from "../../server/meadow/config";
import type { MeadowEvent } from "../../server/meadow/core/events";
import { getDb } from "../../server/meadow/core/db";
import { FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { askHuman, requestSystemAction } from "../../server/meadow/guard/broker";
import { freeDiskMb, harness } from "../../server/meadow/harness/runner";
import { approvePlan, createProject, savePlanVersion } from "../../server/meadow/projects";
import { tempHome, THREE_PHASE_PLAN } from "../helpers";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
  saveConfig({ harness: { e2e: false } });
});
afterEach(async () => {
  await harness.shutdown();
  vi.unstubAllGlobals();
  delete process.env.MEADOW_MIN_FREE_DISK_MB;
  env.cleanup();
});

describe("Telegram network drops", () => {
  it("classifies which errors are worth retrying", () => {
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toBe(true);
    expect(isTransient(new TelegramError("Bad Gateway", 502))).toBe(true);
    expect(isTransient(new TelegramError("Bad Request: chat not found", 400))).toBe(false);
    expect(isTransient(new TelegramError("Unauthorized", 401))).toBe(false);
  });

  it("retries a send through a short outage, but not a rejection", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      calls += 1;
      if (calls <= 2) throw new TypeError("fetch failed");
      const body = JSON.parse(init.body);
      if (body.chat_id === 1) return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }));
    });
    const api = new TelegramApi("123:TOKEN", "https://api.telegram.org", { attempts: 4, baseMs: 1 });
    expect(await api.sendMessage(42, "hello")).toEqual({ message_id: 9 });
    expect(calls).toBe(3);
    await expect(api.sendMessage(1, "hello")).rejects.toThrow(/chat not found/);
    expect(calls).toBe(4);
  });

  it("gives up after its retries so callers can queue the message", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const api = new TelegramApi("123:TOKEN", "https://api.telegram.org", { attempts: 2, baseMs: 1 });
    await expect(api.sendMessage(42, "hello")).rejects.toThrow(/fetch failed/);
  });

  it("keeps cards while offline and sends them in order when Telegram is back", async () => {
    saveConfig({ telegram: { notificationLevel: "failures" } });
    let online = false;
    const sent: string[] = [];
    const api = {
      sendMessage: async (_chat: number, text: string) => {
        if (!online) throw new TypeError("fetch failed");
        sent.push(text);
        return { message_id: sent.length };
      },
      editMessage: async () => null,
      sendPhotos: async () => undefined,
    };
    const notifier = new Notifier({ ownerChat: () => 42, api: api as never });
    const event = (id: number, title: string): MeadowEvent => ({ id, projectId: null, executionId: null, runId: null, phaseId: null, ts: "", type: "setup", title, detail: "", payload: { service: "supabase", needsLogin: true } });
    await notifier.dispatch(event(1, "first"));
    await notifier.dispatch(event(2, "second"));
    await notifier.idle();
    expect(notifier.offlineCount()).toBe(2);
    online = true;
    await notifier.flushOffline();
    await notifier.idle();
    expect(sent.map(text => text.split("\n")[0])).toEqual(["🔌 first", "🔌 second"]);
    expect(notifier.offlineCount()).toBe(0);
  });
});

describe("resource limits", () => {
  it("won't start a run when the disk is nearly full", async () => {
    expect(freeDiskMb(env.root)).toBeGreaterThan(0);
    process.env.MEADOW_MIN_FREE_DISK_MB = String(Number.MAX_SAFE_INTEGER);
    setEngine(new FakeEngine());
    const project = await createProject({ name: "full-disk", engine: "fake" });
    await approvePlan(savePlanVersion(project.id, THREE_PHASE_PLAN).id);
    await expect(harness.start(project.id)).rejects.toThrow(/disk space/);
  });

  it("caps open questions and system requests so the engine can't flood Telegram", async () => {
    const project = await createProject({ name: "flood", engine: "fake" });
    for (let i = 0; i < 3; i++) void askHuman({ projectId: project.id, question: `Question ${i}?`, pollMs: 50 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const fourth = await askHuman({ projectId: project.id, question: "One more?", pollMs: 50 });
    expect(fourth.note).toMatch(/already has 3 unanswered/);
    for (let i = 0; i < 3; i++) void requestSystemAction({ projectId: project.id, command: `git push origin b${i}`, reason: "publish", pollMs: 50 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const extra = await requestSystemAction({ projectId: project.id, command: "git push origin b9", reason: "publish", pollMs: 50 });
    expect(extra.output).toMatch(/already has 3 system requests/);
    getDb().run("UPDATE approvals SET status = 'denied'");
  });
});
