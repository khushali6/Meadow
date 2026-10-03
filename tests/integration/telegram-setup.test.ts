import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramChannel } from "../../server/meadow/channels/telegram";
import { saveConfig } from "../../server/meadow/config";
import { defaultFakeScript, FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { harness } from "../../server/meadow/harness/runner";
import { handleAction, handleDocument, handleText } from "../../server/meadow/intake/conversation";
import { setLlm, type ChatMessage, type LlmClient } from "../../server/meadow/llm/client";
import { approvePlan, createProject, findProject, latestPlan, savePlanVersion } from "../../server/meadow/projects";
import { tempHome, THREE_PHASE_PLAN } from "../helpers";

const PLAN = `---
project: tg-plan
goal: Imported from Telegram
stack: [node]
phases:
  - id: 1
    name: Scaffold
    tasks: [Create index]
    checks:
      - file_exists: src/index.js
    done_when: index exists
---
`;

class IdeaLlm implements LlmClient {
  async chat(messages: ChatMessage[]) {
    const system = messages[0].content;
    const reply = (text: string) => ({ text, model: "test", tokensIn: 1, tokensOut: 1 });
    if (system.includes("You classify requests")) return reply(JSON.stringify({ intent: "new_project", confidence: 0.9, needs_clarification: false, project_hint: null }));
    if (system.includes("clarifying questions")) return reply(JSON.stringify({ questions: [] }));
    if (system.includes("kebab-case project name")) return reply("splitter");
    if (system.includes("You write SPEC.md")) return reply("# splitter\n## Goal\nSplit bills");
    if (system.includes("Meadow's planner")) return reply(PLAN.replace("tg-plan", "splitter"));
    return reply("ok");
  }
  async embed(texts: string[]) {
    return texts.map(() => [1, 0, 0]);
  }
  async transcribe() {
    return "";
  }
  async models() {
    return ["auto"];
  }
}

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
  saveConfig({ harness: { e2e: false } });
  setLlm(new IdeaLlm());
});
afterEach(async () => {
  await harness.shutdown();
  vi.unstubAllGlobals();
  setLlm(null);
  env.cleanup();
});

const doc = (name: string, content: string | Buffer, caption?: string) => handleDocument("telegram", "42", { name, data: typeof content === "string" ? Buffer.from(content) : content, caption });

describe("files sent on Telegram", () => {
  it("imports a PLAN.md into a new project for review", async () => {
    const reply = await doc("PLAN.md", PLAN);
    expect(reply.text).toMatch(/new project tg-plan/);
    expect(latestPlan(findProject("tg-plan")!.id)?.status).toBe("draft");
  });

  it("starts a new project from a spec file without a caption", async () => {
    const reply = await doc("SPEC.md", "# Splitter\nSplit bills between friends, track balances and settle up.");
    expect(reply.text).not.toMatch(/went wrong/);
    expect(latestPlan(findProject("splitter")!.id)?.status).toBe("draft");
  });

  it("rejects empty, binary, non-UTF-8 and unsupported files with a clear reason", async () => {
    expect((await doc("PLAN.md", "  \n")).text).toMatch(/empty/);
    expect((await doc("notes.md", Buffer.from([0x23, 0x00, 0x01]))).text).toMatch(/binary/);
    expect((await doc("notes.md", Buffer.from(Array(200).fill(0xff)))).text).toMatch(/UTF-8/);
    expect((await doc("design.pdf", "x")).text).toMatch(/\.md or \.txt/);
    expect((await doc("big.md", Buffer.alloc(20 * 1024 * 1024 + 1, 0x61))).text).toMatch(/20 MB/);
  });

  it("uses a slash-command caption", async () => {
    expect((await doc("idea.txt", "anything", "/help")).text).toMatch(/Commands:/);
  });
});

describe("/projects picker and queueing", () => {
  it("lists projects with their status as buttons and switches on tap", async () => {
    const a = await createProject({ name: "alpha", engine: "fake" });
    await createProject({ name: "beta", engine: "fake" });
    const picker = await handleText("telegram", "42", "/projects");
    expect(picker.buttons?.map(row => row[0].label.replace(/^▸ /, "")).sort()).toEqual(["alpha · no run yet", "beta · no run yet"]);
    expect(picker.buttons?.map(row => row[0].action).sort()).toEqual([`pick:${a.id}`, `pick:${a.id + 1}`]);
    expect((await handleAction("telegram", "42", `pick:${a.id}`, "telegram:42")).text).toMatch(/Switched to alpha/);
    expect((await handleText("telegram", "42", "/projects")).buttons?.flat().filter(button => button.label.startsWith("▸")).map(button => button.label)).toEqual(["▸ alpha · no run yet"]);
  });

  it("says a newly approved plan is queued while another project is running", async () => {
    const engine = new FakeEngine();
    engine.setScript((req, n) => [{ delayMs: 400, event: { type: "message", title: "working" } }, ...defaultFakeScript(req, n)]);
    setEngine(engine);
    const first = await createProject({ name: "first", engine: "fake" });
    await approvePlan(savePlanVersion(first.id, THREE_PHASE_PLAN).id);
    await harness.start(first.id);
    const second = await createProject({ name: "second", engine: "fake" });
    const draft = savePlanVersion(second.id, THREE_PHASE_PLAN);
    const reply = await handleAction("telegram", "42", `approve:${draft.id}`, "telegram:42");
    expect(reply.text).toMatch(/queued\. first is running/);
    await harness.stop(first.id).catch(() => undefined);
    await harness.stop(second.id).catch(() => undefined);
  }, 30_000);
});

describe("Telegram channel", () => {
  function mockTelegram(updates: unknown[]) {
    const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
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

  it("explains photos and oversized files instead of failing silently", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz0";
    saveConfig({ telegram: { ownerId: 42 } });
    const from = { id: 42 };
    const chat = { id: 42, type: "private" };
    const sent = mockTelegram([
      { update_id: 1, message: { message_id: 1, from, chat, photo: [{ file_id: "p" }] } },
      { update_id: 2, message: { message_id: 2, from, chat, document: { file_id: "d", file_name: "PLAN.md", file_size: 30 * 1024 * 1024 } } },
    ]);
    const channel = new TelegramChannel();
    await channel.start();
    for (let i = 0; i < 100 && sent.filter(item => item.method === "sendMessage").length < 2; i++) await new Promise(resolve => setTimeout(resolve, 30));
    channel.stop();
    delete process.env.TELEGRAM_BOT_TOKEN;
    const texts = sent.filter(item => item.method === "sendMessage").map(item => String(item.body.text));
    expect(texts[0]).toMatch(/can't read images/);
    expect(texts[1]).toMatch(/20 MB/);
  });
});
