import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

export const isWsl = () => process.platform === "linux" && (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(os.release()));

const gitFix = () => (process.platform === "darwin" ? "Run `xcode-select --install` or `brew install git`." : process.platform === "win32" ? "Install Git for Windows (winget install Git.Git) and reopen the terminal." : "Install git with your package manager (apt install git, dnf install git, …).");

/** Platform, data folder and network facts that explain most "works on my machine" failures. */
export function environmentChecks(): SystemCheck[] {
  const checks: SystemCheck[] = [];
  const platform = `${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : isWsl() ? "Linux (WSL)" : process.platform} ${os.release()} · ${process.arch}`;
  const supported = ["darwin", "linux", "win32"].includes(process.platform);
  const translated = process.platform === "darwin" && process.arch === "x64" && os.cpus()[0]?.model.includes("Apple");
  checks.push({
    name: "Platform",
    ok: supported && !translated,
    detail: translated ? `${platform} — this Node is the Intel build running under Rosetta` : platform,
    fix: translated ? "Install the arm64 build of Node.js for full speed (nvm and fnm pick it automatically)." : supported ? undefined : "Meadow supports macOS, Linux and Windows (native or WSL).",
  });
  if (isWsl()) {
    const onWindowsDrive = process.cwd().startsWith("/mnt/");
    checks.push({ name: "WSL", ok: !onWindowsDrive, optional: true, detail: onWindowsDrive ? "Working under /mnt/… (the Windows drive) — file watching and git are much slower there" : "Repos on the Linux filesystem", fix: "Keep repositories under your WSL home (~/code), not /mnt/c. Open the dashboard from Windows at the printed 127.0.0.1 URL." });
  }
  const home = meadowHome();
  let writable = false;
  let freeDetail = "";
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const probe = path.join(home, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    writable = true;
    const stats = fs.statfsSync(home);
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
    freeDetail = ` · ${freeGb.toFixed(1)} GB free`;
    if (freeGb < 1) checks.push({ name: "Disk space", ok: false, detail: `${freeGb.toFixed(2)} GB free where Meadow keeps its data`, fix: "Free some space: backups, logs and the index need room, and SQLite fails on a full disk." });
  } catch {
    /* reported below */
  }
  checks.push({ name: "Data folder", ok: writable, detail: `${home}${writable ? freeDetail : " is not writable"}`, fix: writable ? undefined : "Set MEADOW_HOME to a writable local folder (not a network share or read-only mount)." });
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy && !process.env.NODE_USE_ENV_PROXY) checks.push({ name: "Proxy", ok: false, optional: true, detail: "A proxy is configured, but Node ignores proxy variables by default", fix: "Set NODE_USE_ENV_PROXY=1 (Node 24+) so cloud providers and Telegram go through it; add 127.0.0.1,localhost to NO_PROXY." });
  return checks;
}

export async function systemChecks(): Promise<SystemCheck[]> {
  const checks: SystemCheck[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node.js", ok: major >= 24 || (major === 22 && minor >= 16), detail: `v${process.versions.node}`, fix: "Install Node.js 22.16+ or 24+ (current LTS from nodejs.org)." });
  checks.push(...environmentChecks());
  const gitVersion = await capture("git", ["--version"]);
  checks.push({ name: "git", ok: gitVersion.code === 0, detail: gitVersion.stdout.trim() || "not found", fix: gitFix() });
  checks.push(await llmStatus());
  const routing = llmRouting();
  checks.push({ name: "Memory", ok: routing.embeddings.mode !== "blocked", detail: routing.embeddings.mode === "blocked" ? routing.embeddings.reason : `Stored locally in ${meadowHome()} · embeddings: ${routing.embeddings.name}` });
  const whisper = await localWhisper();
  checks.push({ name: "Voice transcription", ok: routing.voice.available || Boolean(whisper), optional: true, detail: routing.voice.available ? `Via ${routing.voice.name}${whisper ? " (whisper.cpp fallback ready)" : ""}` : whisper ? "On this machine via whisper.cpp" : routing.voice.reason, fix: "Pick a provider with transcription, or install whisper.cpp + ffmpeg and set MEADOW_WHISPER_MODEL." });
  const pw = await playwrightStatus();
  checks.push({ name: "Screenshots", ok: pw.ok, optional: true, detail: pw.detail });
  {
    const hosted = loadConfig().telegram.mode === "hosted" && Boolean(getSecret("TELEGRAM_RELAY_TOKEN"));
    const own = Boolean(getSecret("TELEGRAM_BOT_TOKEN"));
    const paired = loadConfig().telegram.ownerId !== null;
    checks.push({ name: "Telegram", ok: (hosted || own) && paired, optional: true, detail: hosted ? (paired ? "Connected to the Meadow bot" : "Link requested, not connected yet") : own ? (paired ? "Own bot, owner paired" : "Own bot token set, not paired yet") : "Not connected", fix: "Runtime settings → Telegram → Connect Telegram (or `meadow init`)." });
  }
  const ffmpeg = await which("ffmpeg");
  const piper = await which("piper");
  checks.push({ name: "Spoken replies (Piper + ffmpeg)", ok: Boolean(ffmpeg && piper && process.env.MEADOW_PIPER_MODEL), optional: true, detail: `ffmpeg ${ffmpeg ? "found" : "missing"}, piper ${piper ? "found" : "missing"}${process.env.MEADOW_PIPER_MODEL ? "" : ", MEADOW_PIPER_MODEL unset"}` });
  return checks;
}

export async function fullDoctor(): Promise<{ system: SystemCheck[]; engines: DoctorReport[]; defaultEngine: string }> {
  const [system, engines] = await Promise.all([systemChecks(), doctorAll()]);
  return { system, engines, defaultEngine: effectiveDefaultEngine() };
}
