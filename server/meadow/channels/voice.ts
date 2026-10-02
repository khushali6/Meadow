import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capture, which } from "../core/exec";
import { getLlm } from "../llm/client";

/** Transcribe a voice note through the local FreeLLMAPI gateway (/v1/audio/transcriptions). */
export async function transcribe(audio: Buffer, filename: string): Promise<string> {
  return getLlm().transcribe(audio, filename.endsWith(".oga") ? filename.replace(/\.oga$/, ".ogg") : filename);
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
