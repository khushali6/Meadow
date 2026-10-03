import { execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier } from "../../server/meadow/channels/notifier";
import { TelegramChannel } from "../../server/meadow/channels/telegram";
import { saveConfig, setSecret } from "../../server/meadow/config";
import { getDb } from "../../server/meadow/core/db";
import { defaultFakeScript, FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { askHuman } from "../../server/meadow/guard/broker";
import { harness } from "../../server/meadow/harness/runner";
import { setLlm, type ChatMessage, type LlmClient } from "../../server/meadow/llm/client";
import { findProject } from "../../server/meadow/projects";
import { meadowCreatedRepo } from "../../server/meadow/services/github";
import { tempHome } from "../helpers";

const PLAN = `---
project: splitter
goal: Split bills between friends
stack: [node]
phases:
  - id: 1
    name: Scaffold
    tasks: [Create the entry file]
    checks:
      - file_exists: src/index.js
    done_when: The entry file exists
  - id: 2
    name: Balances
    depends_on: [1]
    tasks: [Track balances]
    checks:
      - file_exists: src/index.js
    done_when: Balances are tracked
---
`;

class ScriptedLlm implements LlmClient {
  async chat(messages: ChatMessage[]) {
    const system = messages[0].content;
    const reply = (text: string) => ({ text, model: "test", tokensIn: 1, tokensOut: 1 });
    if (system.includes("You classify requests")) return reply(JSON.stringify({ intent: "new_project", confidence: 0.95, needs_clarification: false, project_hint: null }));
    if (system.includes("clarifying questions")) return reply(JSON.stringify({ questions: [] }));
    if (system.includes("kebab-case project name")) return reply("splitter");
    if (system.includes("You write SPEC.md")) return reply("# splitter\n## Goal\nSplit bills");
    if (system.includes("Meadow's planner")) return reply(PLAN);
    if (system.includes("factual engineering summaries")) return reply("Done.");
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

type Sent = { method: string; body: Record<string, unknown> };
let env: ReturnType<typeof tempHome>;
let github: http.Server;
let channel: TelegramChannel;
let notifier: Notifier;

beforeEach(async () => {
  process.env.MEADOW_ENGINE = "fake";
  env = tempHome();
  saveConfig({ harness: { e2e: false }, telegram: { ownerId: 42, notificationLevel: "phases" } });
  setLlm(new ScriptedLlm());
  process.env.TELEGRAM_BOT_TOKEN = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz0";
  setSecret("GITHUB_TOKEN", "ghp_testtoken123456");
  github = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const bare = path.join(env.root, `${body.name}.git`);
      execFileSync("git", ["init", "--bare", "--quiet", bare]);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clone_url: bare, html_url: `https://github.com/me/${body.name}`, full_name: `me/${body.name}` }));
    });
  });
  await new Promise<void>(resolve => github.listen(0, "127.0.0.1", resolve));
  process.env.MEADOW_GITHUB_API = `http://127.0.0.1:${(github.address() as { port: number }).port}`;
});

afterEach(async () => {
  notifier?.stop();
  channel?.stop();
  await harness.shutdown();
  vi.unstubAllGlobals();
  setLlm(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.MEADOW_GITHUB_API;
  delete process.env.MEADOW_ENGINE;
  await new Promise(resolve => github.close(resolve));
  env.cleanup();
});

/** A stand-in for the Telegram Bot API: the test pushes updates as the user, and every outgoing call is recorded. */
function telegram() {
  const inbox: unknown[] = [];
  const sent: Sent[] = [];
  let updateId = 0;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init: { body: unknown }) => {
    if (!String(url).includes("api.telegram.org")) return realFetch(url, init as RequestInit);
    const method = String(url).split("/").pop()!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "meadow_test_bot" } }));
    if (method === "getUpdates") {
      if (!inbox.length) await new Promise(resolve => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ ok: true, result: inbox.splice(0) }));
    }
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
  const from = { id: 42 };
  const chat = { id: 42, type: "private" };
  return {
    sent,
    say: (text: string) => inbox.push({ update_id: ++updateId, message: { message_id: updateId, from, chat, text } }),
    tap: (data: string) => inbox.push({ update_id: ++updateId, callback_query: { id: `q${updateId}`, from, data, message: { message_id: 1, chat: { id: 42 } } } }),
    texts: () => sent.filter(item => item.method === "sendMessage").map(item => String(item.body.text)),
    buttons: () => sent.flatMap(item => ((item.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat().map(button => button.callback_data)),
  };
}

async function until<T>(check: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out");
}

describe("Telegram only, end to end", () => {
  it("idea → plan card → approve → private repo → engine question answered by tap → phases pushed → finished card", async () => {
    const engine = new FakeEngine();
    engine.setScript((req, n) => [{ event: { type: "thinking", title: "Thinking" }, delayMs: n === 0 ? 400 : 10 }, ...defaultFakeScript(req, n)]);
    setEngine(engine);
    const tg = telegram();
    channel = new TelegramChannel();
    await channel.start();
    notifier = new Notifier(channel);
    notifier.start();

    tg.say("Build me an app that splits bills between friends and settles up");
    const approve = await until(() => tg.buttons().find(data => data.startsWith("approve:")));
    expect(tg.texts().join("\n")).toMatch(/approve/i);

    tg.tap(approve);
    const project = await until(() => findProject("splitter"));
    expect(project.engine).toBe("fake");
    await until(() => getDb().get<{ id: number }>("SELECT id FROM events WHERE project_id = ? AND type = 'phase_started'", project.id));

    const answer = askHuman({ projectId: project.id, question: "Which currency should balances use?", options: ["USD", "EUR"], pollMs: 20 });
    const reply = await until(() => tg.buttons().find(data => /^reply:\d+:1$/.test(data)));
    expect(tg.texts().some(text => text.includes("Which currency"))).toBe(true);
    tg.tap(reply);
    expect(await answer).toMatchObject({ answered: true, answer: "EUR" });

    await until(() => getDb().get<{ status: string }>("SELECT status FROM executions WHERE project_id = ? AND status = 'completed'", project.id), 30_000).catch(error => {
      console.error(getDb().all("SELECT status, note FROM executions"), getDb().all("SELECT type, title, substr(detail, 1, 300) AS detail FROM events ORDER BY id DESC LIMIT 12"));
      throw error;
    });
    await notifier.idle();
    const repo = meadowCreatedRepo(project.id)!;
    expect(repo.fullName).toBe("me/splitter");
    expect(execFileSync("git", ["--git-dir", repo.cloneUrl, "log", "--oneline", project.base_branch]).toString()).toMatch(/phase 2 passed/);
    await until(() => tg.texts().some(text => /Every phase passed/.test(text))).catch(error => {
      console.error(tg.sent.map(item => `${item.method}: ${String(item.body.text ?? "").slice(0, 80)}`));
      throw error;
    });
  }, 60_000);
});
