import { localWhisper } from "./channels/voice";
import { getSecret, loadConfig, meadowHome } from "./config";
import { capture, which } from "./core/exec";
import type { DoctorReport } from "./engines/base";
import { doctorAll, effectiveDefaultEngine } from "./engines/registry";
import { resolveProvider } from "./llm/catalog";
import { chatProviderId, healthCheck, llmRouting } from "./llm/router";
import type { HealthStep } from "./llm/types";
import { playwrightStatus } from "./visual/capture";

export type SystemCheck = { name: string; ok: boolean; optional?: boolean; detail: string; fix?: string };

export async function llmStatus(): Promise<SystemCheck & { provider: string; steps: HealthStep[] }> {
  const id = chatProviderId();
  const resolved = resolveProvider(id);
  const fix = resolved.def.id === "freellmapi" ? "Start the gateway (cd ~/freellmapi && docker compose up -d), copy the unified key from http://127.0.0.1:3001, then run `meadow init`." : resolved.def.type === "local" ? `Start ${resolved.name} on this machine and choose a model.` : `Add your ${resolved.name} key (${resolved.def.secret}) in Runtime settings → Agent model.`;
  const health = await healthCheck(id, { chat: false });
  const failed = health.steps.find(step => !step.ok && !step.skipped);
  return {
    name: `Agent model · ${resolved.name}`,
    ok: health.ok,
    detail: failed ? `${failed.name}: ${failed.detail}` : `${resolved.model} · ${health.steps.filter(step => step.ok && !step.skipped).map(step => step.detail).join(" · ")}`,
    fix: health.ok ? undefined : fix,
    provider: id,
    steps: health.steps,
  };
}

export async function systemChecks(): Promise<SystemCheck[]> {
  const checks: SystemCheck[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node.js", ok: major > 22 || (major === 22 && minor >= 5), detail: `v${process.versions.node}`, fix: "Install Node.js 22.5 or newer." });
  const gitVersion = await capture("git", ["--version"]);
  checks.push({ name: "git", ok: gitVersion.code === 0, detail: gitVersion.stdout.trim() || "not found", fix: "Install git." });
  checks.push(await llmStatus());
  const routing = llmRouting();
  checks.push({ name: "Memory", ok: routing.embeddings.mode !== "blocked", detail: routing.embeddings.mode === "blocked" ? routing.embeddings.reason : `Stored locally in ${meadowHome()} · embeddings: ${routing.embeddings.name}` });
  const whisper = await localWhisper();
  checks.push({ name: "Voice transcription", ok: routing.voice.available || Boolean(whisper), optional: true, detail: routing.voice.available ? `Via ${routing.voice.name}${whisper ? " (whisper.cpp fallback ready)" : ""}` : whisper ? "On this machine via whisper.cpp" : routing.voice.reason, fix: "Pick a provider with transcription, or install whisper.cpp + ffmpeg and set MEADOW_WHISPER_MODEL." });
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
  return { system, engines, defaultEngine: effectiveDefaultEngine() };
}
