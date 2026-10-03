import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Notifier } from "../../server/meadow/channels/notifier";
import { applyEvent, renderProgress, startProgress } from "../../server/meadow/channels/progress";
import { saveConfig } from "../../server/meadow/config";
import type { MeadowEvent } from "../../server/meadow/core/events";
import { defaultFakeScript, FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { harness } from "../../server/meadow/harness/runner";
import { approvePlan, createProject, savePlanVersion } from "../../server/meadow/projects";
import { settled, tempHome, THREE_PHASE_PLAN } from "../helpers";

type Call = { method: "send" | "edit"; text: string; messageId: number; silent?: boolean; buttons?: unknown };

function fakeTarget() {
  const calls: Call[] = [];
  let next = 100;
  const api = {
    async sendMessage(_chat: number, text: string, buttons?: unknown, options: { silent?: boolean } = {}) {
      const messageId = next++;
      calls.push({ method: "send", text, messageId, silent: options.silent, buttons });
      return { message_id: messageId };
    },
    async editMessage(_chat: number, messageId: number, text: string) {
      calls.push({ method: "edit", text, messageId });
      return null;
    },
    async sendPhotos() {},
  };
  return { calls, target: { ownerChat: () => 42, api } };
}

let env: ReturnType<typeof tempHome>;
let notifier: Notifier;

beforeEach(() => {
  env = tempHome();
  saveConfig({ telegram: { ownerId: 42 } });
});

afterEach(async () => {
  notifier?.stop();
  await harness.shutdown();
  env.cleanup();
});

async function runPlan(engine: FakeEngine) {
  setEngine(engine);
  const project = await createProject({ name: "demo-app", engine: "fake" });
  await approvePlan(savePlanVersion(project.id, THREE_PHASE_PLAN).id);
  const done = settled(project.id);
  await harness.start(project.id);
  const final = await done;
  await new Promise(resolve => setTimeout(resolve, 50));
  await notifier.idle();
  return final;
}

describe("telegram progress feed during a real harness run", () => {
  it("posts run start, a live card per phase, fix attempts, phase results and completion", async () => {
    const { calls, target } = fakeTarget();
    notifier = new Notifier(target);
    notifier.start();
    const engine = new FakeEngine();
    // First engine call skips the entry file so phase 1 fails its check and needs a fix attempt.
    engine.setScript((req, n) => (n === 0 ? [{ event: { type: "session_started", title: "Fake engine session started" } }, { write: { path: "notes/x.md", content: "x" } }, { event: { type: "done", title: "done", ok: true, reason: "completed" } }] : defaultFakeScript(req, n)));
    const final = await runPlan(engine);
    expect(final.payload?.status).toBe("completed");

    const sends = calls.filter(call => call.method === "send").map(call => call.text);
    expect(sends.some(text => text.startsWith("🚀 Run started on Fake engine"))).toBe(true);
    expect(sends.filter(text => /^⚙️ demo-app · Phase \d of 3/.test(text))).toHaveLength(3);
    expect(sends.some(text => text.startsWith("🔁 ") && /fix attempt 2/.test(text))).toBe(true);
    for (const n of [1, 2, 3]) expect(sends.some(text => text.startsWith(`Phase ${n} of 3 passed`))).toBe(true);
    expect(sends.some(text => text.startsWith("🎉 All phases passed"))).toBe(true);

    // Each phase card ends edited to its final state with the check list.
    const cardIds = calls.filter(call => call.method === "send" && call.text.startsWith("⚙️ demo-app")).map(call => call.messageId);
    for (const id of cardIds) {
      const last = calls.filter(call => call.messageId === id).at(-1)!;
      expect(last.text).toMatch(/^✅ demo-app · Phase \d of 3/);
      expect(last.text).toContain("Now: ✅ Phase passed");
      expect(last.text).toMatch(/Checks\n✓ /);
    }
    const phaseOne = calls.filter(call => call.messageId === cardIds[0]).at(-1)!.text;
    expect(phaseOne).toContain("▰▰▰▱▱▱▱▱▱▱ 1 of 3 phases done");
    expect(phaseOne).toMatch(/🔁 Attempt 1 failed; starting fix attempt 2/);

    // Progress noise is silent; milestones that need attention are not.
    expect(calls.find(call => call.text.startsWith("🔁 "))?.silent).toBe(true);
    expect(calls.find(call => call.text.startsWith("🚀 "))?.silent).toBeFalsy();
  }, 30_000);

  it("sends short phase messages and no live cards at the 'phases' level", async () => {
    saveConfig({ telegram: { notificationLevel: "phases" } });
    const { calls, target } = fakeTarget();
    notifier = new Notifier(target);
    notifier.start();
    const engine = new FakeEngine();
    engine.setScript(defaultFakeScript);
    await runPlan(engine);
    const sends = calls.map(call => call.text);
    expect(sends.some(text => text.startsWith("⚙️"))).toBe(false);
    expect(sends.filter(text => text.startsWith("▶️ Phase"))).toHaveLength(3);
    expect(calls.filter(call => call.method === "edit")).toHaveLength(0);
  }, 30_000);

  it("sends nothing but problems at the 'failures' level", async () => {
    saveConfig({ telegram: { notificationLevel: "failures" } });
    const { calls, target } = fakeTarget();
    notifier = new Notifier(target);
    notifier.start();
    const engine = new FakeEngine();
    engine.setScript(defaultFakeScript);
    await runPlan(engine);
    const reviews = calls.filter(call => JSON.stringify(call).includes("Approve and start"));
    expect(reviews).toHaveLength(1);
    expect(calls.filter(call => !reviews.includes(call))).toEqual([]);
  }, 30_000);
});

describe("finished app showcase", async () => {
  const browser = await (await import("../../server/meadow/visual/browser")).findBrowser();
  it.skipIf(!browser)("starts the finished app, screenshots it and sends the photos with the completion report", async () => {
    saveConfig({ telegram: { notificationLevel: "phases" } });
    const photos: Array<{ path: string; caption: string }> = [];
    const { calls, target } = fakeTarget();
    target.api.sendPhotos = async (_chat: number, items: Array<{ path: string; caption: string }>) => void photos.push(...items);
    notifier = new Notifier(target);
    notifier.start();
    const engine = new FakeEngine();
    engine.setScript(defaultFakeScript);
    setEngine(engine);
    const project = await createProject({ name: "web-app", engine: "fake" });
    const fs = await import("node:fs");
    fs.writeFileSync(`${project.path}/index.html`, "<h1>Split the bill</h1>");
    await approvePlan(savePlanVersion(project.id, THREE_PHASE_PLAN).id);
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");
    await new Promise(resolve => setTimeout(resolve, 200));
    const report = calls.find(call => call.text.startsWith("🎉"));
    expect(report?.text).toContain("Run it yourself");
    expect(report?.text).toContain("Screenshots of the running app");
    expect(photos.map(photo => photo.caption)).toEqual(["Finished app · / · desktop", "Finished app · / · mobile"]);
    for (const photo of photos) expect(fs.statSync(photo.path).size).toBeGreaterThan(1000);
  }, 120_000);
});

describe("progress card rendering", () => {
  const event = (type: MeadowEvent["type"], title: string, extra: Partial<MeadowEvent> = {}): MeadowEvent => ({ id: 1, projectId: 1, executionId: 1, runId: null, phaseId: 1, ts: "2026-10-02T10:00:00.000Z", type, title, detail: "", ...extra });

  it("tracks stage, attempts, checks and blocked state", () => {
    const progress = startProgress(event("phase_started", "Phase 2 of 4 started: Checkout", { payload: { phaseNumber: 2, total: 4 }, detail: "Branch meadow/phase-2-checkout" }), { projectName: "shop", engine: "Claude Code", maxAttempts: 3 });
    applyEvent(progress, event("session_started", "Claude Code session started", { runId: 7 }));
    applyEvent(progress, event("file_edit", "Edited src/cart.ts", { runId: 7 }));
    applyEvent(progress, event("check_result", "✗ npm test", { payload: { passed: false } }));
    applyEvent(progress, event("message", "Attempt 1 failed; starting fix attempt 2"));
    let text = renderProgress(progress, Date.parse("2026-10-02T10:03:12.000Z"));
    expect(text).toContain("⚙️ shop · Phase 2 of 4");
    expect(text).toContain("Now: 🔧 Fixing failed checks · attempt 2 of 3");
    expect(text).toContain("Engine: Claude Code");
    expect(text).toContain("Elapsed: 3m 12s · 1 file edit");
    expect(text).toContain("✗ npm test");
    applyEvent(progress, event("check_result", "✓ npm test", { payload: { passed: true } }));
    applyEvent(progress, event("phase_blocked", "Phase 2 is stuck after 3 attempts: Checkout", { ts: "2026-10-02T10:05:00.000Z" }));
    text = renderProgress(progress);
    expect(text).toMatch(/^⛔ shop · Phase 2 of 4/);
    expect(text).toContain("Now: ⛔ Blocked, needs you");
    expect(text).toContain("Elapsed: 5m 0s");
    expect(text).toContain("✓ npm test");
    expect(text).not.toContain("✗ npm test");
  });
});
