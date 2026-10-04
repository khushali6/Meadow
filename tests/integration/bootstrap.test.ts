import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { removeTemp } from "../helpers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-bootstrap-"));
process.env.MEADOW_HOME = path.join(dir, "home");
process.env.MEADOW_NO_BROWSER = "1";
delete process.env.MEADOW_ENGINE;
delete process.env.TELEGRAM_BOT_TOKEN;
const mark = path.join(dir, "signed-in");
const fakeCursor = path.join(dir, "agent");
fs.writeFileSync(
  fakeCursor,
  `#!/bin/sh
case "$1" in
  --help) echo "--print --output-format stream-json --force --trust --workspace --model";;
  --version) echo "2026.01.01-test";;
  status) if [ -f "${mark}" ]; then echo "Logged in as dev@example.com"; else echo "Not logged in"; fi;;
  login) echo "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc"; sleep 0.3; touch "${mark}";;
esac
`,
  { mode: 0o755 },
);
process.env.MEADOW_CURSOR_BIN = fakeCursor;
afterAll(() => removeTemp(dir));
afterEach(() => vi.unstubAllGlobals());

const boot = await import("../../server/meadow/setup/bootstrap");
const { getSecret, loadConfig, storedSecret } = await import("../../server/meadow/config");
const { getDb } = await import("../../server/meadow/core/db");
getDb();

function scriptedIO(answers: string[], interactive = true) {
  const lines: string[] = [];
  const io: import("../../server/meadow/setup/bootstrap").SetupIO = {
    interactive,
    yes: false,
    log: (line = "") => lines.push(line),
    ask: async (_question, fallback = "") => (answers.length ? answers.shift()! : fallback) || fallback,
    waitOrSkip: work => work,
  };
  return { io, lines };
}

describe("startup setup", () => {
  it("parses env files with comments, export and quotes", () => {
    expect(boot.parseEnvFile("# keys\nexport TELEGRAM_BOT_TOKEN=\"123:abc\"\nCURSOR_API_KEY='key_x'\n\nBAD LINE\nGITHUB_TOKEN=ghp_1")).toEqual({ TELEGRAM_BOT_TOKEN: "123:abc", CURSOR_API_KEY: "key_x", GITHUB_TOKEN: "ghp_1" });
  });

  it("saves only known, non-empty secrets that aren't stored yet", () => {
    const saved = boot.importSecrets({ CURSOR_API_KEY: "key_abcdefgh123", SOMETHING_ELSE: "x".repeat(20), GEMINI_API_KEY: "", OPENAI_API_KEY: "has space in it" });
    expect(saved).toEqual(["CURSOR_API_KEY"]);
    expect(storedSecret("CURSOR_API_KEY")).toBe("key_abcdefgh123");
    expect(boot.importSecrets({ CURSOR_API_KEY: "key_abcdefgh123" })).toEqual([]);
    const mode = fs.statSync(path.join(process.env.MEADOW_HOME!, "secrets.env")).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("recognises providers and bot tokens by shape", () => {
    expect(boot.providerForKey("sk-ant-api03-x")).toBe("anthropic");
    expect(boot.providerForKey("sk-or-v1-x")).toBe("openrouter");
    expect(boot.providerForKey("AIzaSyX")).toBe("gemini");
    expect(boot.providerForKey("sk-proj-x")).toBe("openai");
    expect(boot.providerForKey("fl-123")).toBeNull();
    expect(boot.validBotToken("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(true);
    expect(boot.validBotToken("not-a-token")).toBe(false);
  });

  it("never consents to installs or downloads when nobody can answer, unless --yes", async () => {
    const { io } = scriptedIO([], false);
    expect(await boot.confirm(io, "Start Ollama?", true)).toBe(true);
    expect(await boot.confirm(io, "Install?", true, true)).toBe(false);
    expect(await boot.confirm({ ...io, yes: true }, "Install?", true, true)).toBe(true);
  });

  it("suggests an Ollama model that fits the machine", () => {
    expect(boot.suggestedOllamaModels(32 * 1024 ** 3)[0]).toBe("qwen2.5:14b");
    expect(boot.suggestedOllamaModels(16 * 1024 ** 3)[0]).toBe("qwen2.5:7b");
    expect(boot.suggestedOllamaModels(8 * 1024 ** 3)).toEqual(["qwen2.5:3b", "nomic-embed-text"]);
  });

  it.skipIf(process.platform === "win32")("asks which engine, signs it in through the browser flow and makes it the default", async () => {
    fs.rmSync(path.join(process.env.MEADOW_HOME!, "secrets.env"), { force: true });
    const { io, lines } = scriptedIO(["cursor", "y"]);
    expect(await boot.setupEngine(io)).toBe(true);
    expect(lines.join("\n")).toContain("https://cursor.com/loginDeepControl?challenge=abc");
    expect(lines.join("\n")).toContain("Cursor CLI is connected");
    expect(loadConfig().engine.default).toBe("cursor");
  });

  it("skips Telegram cleanly without a token when nobody can answer", async () => {
    const { io, lines } = scriptedIO([], false);
    expect(await boot.setupTelegram(io)).toBe(false);
    expect(lines.join("\n")).toContain("Set TELEGRAM_BOT_TOKEN");
  });

  it("validates a pasted bot token with Telegram, saves it and creates a pairing link", async () => {
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes(`/bot${token}/getMe`)) return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "my_meadow_bot" } }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
    }));
    const { io, lines } = scriptedIO(["n", "bad", token, ""]);
    io.waitOrSkip = async () => null;
    expect(await boot.setupTelegram(io)).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("doesn't look like a bot token");
    expect(out).toContain("Token works: @my_meadow_bot");
    expect(out).toMatch(/https:\/\/t\.me\/my_meadow_bot\?start=\d{6}/);
    expect(getSecret("TELEGRAM_BOT_TOKEN")).toBe(token);
    expect(loadConfig().telegram.mode).toBe("own");
  });
});
