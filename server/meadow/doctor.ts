import { getSecret, loadConfig } from "./config";
import { capture, which } from "./core/exec";
import type { DoctorReport } from "./engines/base";
import { doctorAll } from "./engines/registry";
import { getLlm } from "./llm/client";
import { playwrightStatus } from "./visual/capture";

export type SystemCheck = { name: string; ok: boolean; optional?: boolean; detail: string; fix?: string };

export async function llmStatus(): Promise<SystemCheck> {
  const baseUrl = loadConfig().llm.baseUrl;
  if (!getSecret("FREELLMAPI_API_KEY")) return { name: "FreeLLMAPI", ok: false, detail: `No key configured for ${baseUrl}`, fix: "Open http://127.0.0.1:3001, copy the unified key from the Keys page, then run `meadow init` (or set FREELLMAPI_API_KEY)." };
  try {
    const models = await getLlm().models();
    return { name: "FreeLLMAPI", ok: true, detail: `${baseUrl} · ${models.length} models available` };
  } catch (error) {
    return { name: "FreeLLMAPI", ok: false, detail: (error as Error).message, fix: "Start the gateway (cd ~/freellmapi && docker compose up -d) and check the key." };
  }
}

export async function systemChecks(): Promise<SystemCheck[]> {
  const checks: SystemCheck[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node.js", ok: major > 22 || (major === 22 && minor >= 5), detail: `v${process.versions.node}`, fix: "Install Node.js 22.5 or newer." });
  const gitVersion = await capture("git", ["--version"]);
  checks.push({ name: "git", ok: gitVersion.code === 0, detail: gitVersion.stdout.trim() || "not found", fix: "Install git." });
  checks.push(await llmStatus());
  const pw = await playwrightStatus();
  checks.push({ name: "Screenshots (Playwright)", ok: pw.ok, optional: true, detail: pw.detail });
  checks.push({ name: "Telegram", ok: Boolean(getSecret("TELEGRAM_BOT_TOKEN")), optional: true, detail: getSecret("TELEGRAM_BOT_TOKEN") ? (loadConfig().telegram.ownerId ? "Bot token set, owner paired" : "Bot token set, not paired yet") : "No bot token", fix: "Create a bot with @BotFather, then run `meadow init`." });
  const ffmpeg = await which("ffmpeg");
  const piper = await which("piper");
  checks.push({ name: "Spoken replies (Piper + ffmpeg)", ok: Boolean(ffmpeg && piper && process.env.MEADOW_PIPER_MODEL), optional: true, detail: `ffmpeg ${ffmpeg ? "found" : "missing"}, piper ${piper ? "found" : "missing"}${process.env.MEADOW_PIPER_MODEL ? "" : ", MEADOW_PIPER_MODEL unset"}` });
  return checks;
}

export async function fullDoctor(): Promise<{ system: SystemCheck[]; engines: DoctorReport[]; defaultEngine: string }> {
  const [system, engines] = await Promise.all([systemChecks(), doctorAll()]);
  return { system, engines, defaultEngine: loadConfig().engine.default };
}
