import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capture, which } from "../core/exec";
import { getLlm } from "../llm/client";

/** whisper.cpp on this machine, when installed with a model in MEADOW_WHISPER_MODEL. Audio never leaves the computer. */
export async function localWhisper(): Promise<{ bin: string; ffmpeg: string; model: string } | null> {
  const model = process.env.MEADOW_WHISPER_MODEL;
  if (!model || !fs.existsSync(model)) return null;
  const bin = (await which("whisper-cli")) ?? (await which("whisper-cpp"));
  const ffmpeg = await which("ffmpeg");
  return bin && ffmpeg ? { bin, ffmpeg, model } : null;
}

async function transcribeLocally(audio: Buffer, filename: string): Promise<string | null> {
  const tools = await localWhisper();
  if (!tools) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-stt-"));
  try {
    const input = path.join(dir, path.basename(filename) || "voice.ogg");
    const wav = path.join(dir, "voice.wav");
    fs.writeFileSync(input, audio);
    const convert = await capture(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", wav], { timeoutMs: 60_000 });
    if (convert.code !== 0) return null;
    const run = await capture(tools.bin, ["-m", tools.model, "-f", wav, "-nt", "-np"], { timeoutMs: 180_000 });
    return run.code === 0 ? run.stdout.replace(/\s+/g, " ").trim() : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Transcribe a voice note with the configured provider; when it can't, fall back to whisper.cpp on this machine. */
export async function transcribe(audio: Buffer, filename: string): Promise<string> {
  const name = filename.endsWith(".oga") ? filename.replace(/\.oga$/, ".ogg") : filename;
  try {
    return await getLlm().transcribe(audio, name);
  } catch (error) {
    if ((error as { type?: string }).type !== "UNSUPPORTED") throw error;
    const local = await transcribeLocally(audio, name);
    if (local !== null) return local;
    throw new Error(`${(error as Error).message} For on-device transcription, install whisper.cpp and ffmpeg and set MEADOW_WHISPER_MODEL to a ggml model file.`);
  }
}

/** Optional spoken status: Piper (local TTS) to WAV, ffmpeg to OGG/Opus. Returns null when either tool is missing. */
export async function speak(text: string): Promise<string | null> {
  const piper = await which("piper");
  const ffmpeg = await which("ffmpeg");
  const model = process.env.MEADOW_PIPER_MODEL;
  if (!piper || !ffmpeg || !model) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-tts-"));
  const wav = path.join(dir, "status.wav");
  const ogg = path.join(dir, "status.ogg");
  const textFile = path.join(dir, "text.txt");
  fs.writeFileSync(textFile, text.slice(0, 800));
  const synth = await capture("sh", ["-c", `"${piper}" --model "${model}" --output_file "${wav}" < "${textFile}"`], { timeoutMs: 60_000 });
  if (synth.code !== 0) return null;
  const convert = await capture(ffmpeg, ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "32k", ogg], { timeoutMs: 60_000 });
  return convert.code === 0 ? ogg : null;
}
