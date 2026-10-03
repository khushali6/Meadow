/**
 * Plans (spec + PLAN.md) written by the Cursor CLI instead of the local LLM.
 *
 * Runs the engine in read-only (ask) mode with a JSON output format, collects all "assistant" text blocks, and
 * returns the concatenated result. The caller is responsible for wrapping the output in the same planLoop /
 * specLoop the local path uses.
 */
import { findBinary, spawnGroup, killTree } from "../core/exec";
import { parseCursorLine } from "../engines/cursor";
import { homePath } from "../config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PlannerResult = { text: string; ok: boolean; error?: string };

/** How long (ms) to wait for Cursor CLI to reply with a plan. Plans are longer than code phases. */
const TIMEOUT_MS = 5 * 60 * 1000;
const SILENCE_MS = 3 * 60 * 1000;

/** Resolve the cursor-agent binary; the same one the engine uses. */
async function resolveBinary(): Promise<string | null> {
  return process.env.MEADOW_CURSOR_BIN || (await findBinary(["cursor-agent", "agent"]));
}

/**
 * Runs the Cursor CLI in read-only mode with `prompt` and collects its text replies.
 * Returns the concatenated assistant text (the plan/spec) or an error.
 */
export async function runCursorPlanner(prompt: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<PlannerResult> {
  const binary = await resolveBinary();
  if (!binary) return { text: "", ok: false, error: "cursor-agent not found. Check Setup → Coding engine." };

  // Detect flags
  const helpResult = await new Promise<string>(resolve => {
    const chunks: Buffer[] = [];
    const child = spawnGroup(binary, ["--help"], { cwd: os.tmpdir(), env: process.env as Record<string, string> });
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", () => resolve(Buffer.concat(chunks).toString()));
    child.on("error", () => resolve(""));
    setTimeout(() => { resolve(Buffer.concat(chunks).toString()); try { killTree(child); } catch { /* ignore */ } }, 20_000);
  });

  const flags = {
    print: helpResult.includes("--print"),
    streamJson: helpResult.includes("stream-json"),
    mode: helpResult.includes("--mode"),
    trust: helpResult.includes("--trust"),
    workspace: helpResult.includes("--workspace"),
  };

  if (!flags.print || !flags.streamJson) return { text: "", ok: false, error: "This cursor-agent version does not support --print + stream-json." };

  const args = ["--print", "--output-format", "stream-json"];
  if (flags.trust) args.push("--trust");
  if (flags.mode) args.push("--mode", "ask");
  args.push(prompt);

  const cwd = options.cwd ?? os.tmpdir();
  const logDir = homePath("logs", "runs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `planner-${Date.now()}.out`);
  const outLog = fs.createWriteStream(logFile);

  return new Promise<PlannerResult>(resolve => {
    const child = spawnGroup(binary, args, { cwd, env: process.env as Record<string, string> });
    outLog.on("error", () => { /* ignore log errors */ });

    const textParts: string[] = [];
    let buffer = "";
    let error = "";

    const total = setTimeout(() => { killTree(child); resolve({ text: textParts.join(""), ok: textParts.length > 0, error: "Cursor CLI timed out while writing the plan." }); }, options.timeoutMs ?? TIMEOUT_MS);
    let silenceTimer = setTimeout(() => { killTree(child); resolve({ text: textParts.join(""), ok: textParts.length > 0, error: "Cursor CLI produced no output for too long." }); }, SILENCE_MS);

    const resetSilence = () => { clearTimeout(silenceTimer); silenceTimer = setTimeout(() => { killTree(child); resolve({ text: textParts.join(""), ok: textParts.length > 0, error: "Cursor CLI silent." }); }, SILENCE_MS); };

    child.stdout?.on("data", (chunk: Buffer) => {
      resetSilence();
      outLog.write(chunk);
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const events = parseCursorLine(line);
        for (const event of events) {
          if (event.type === "message" && event.detail) textParts.push(event.detail);
          if (event.type === "done") {
            clearTimeout(total);
            clearTimeout(silenceTimer);
            outLog.end();
            if (event.ok === false && !textParts.length) error = event.detail || "Cursor reported an error with no output.";
          }
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      resetSilence();
      error += chunk.toString().slice(-2000);
    });

    child.on("close", () => {
      clearTimeout(total);
      clearTimeout(silenceTimer);
      outLog.end();
      const text = textParts.join("").trim();
      resolve({ text, ok: text.length > 0, error: text ? undefined : error.trim() || "Cursor produced no plan text." });
    });

    child.on("error", err => {
      clearTimeout(total);
      clearTimeout(silenceTimer);
      outLog.end();
      resolve({ text: textParts.join("").trim(), ok: false, error: err.message });
    });
  });
}
