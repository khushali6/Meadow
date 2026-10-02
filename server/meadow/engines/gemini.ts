import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSecret } from "../config";
import { capture, findBinary } from "../core/exec";
import { failureReason, type DoctorReport, type Engine, type EngineEvent, type RunRequest } from "./base";
import { Supervisor } from "./supervisor";

const EDIT_TOOLS = new Set(["write_file", "replace", "edit", "edit_file"]);
const SHELL_TOOLS = new Set(["run_shell_command", "shell"]);

/**
 * Parser for `gemini -p … --output-format stream-json`. Assistant text arrives as deltas, so it is
 * buffered and flushed as one message whenever a tool starts or the turn ends.
 */
export function createGeminiParser() {
  let text = "";
  const flush = (): EngineEvent[] => {
    const message = text.trim();
    text = "";
    return message ? [{ type: "message", title: message.split("\n")[0].slice(0, 160), detail: message }] : [];
  };
  return (line: string): EngineEvent[] => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line);
    } catch {
      return [];
    }
    switch (data.type) {
      case "init":
        return [{ type: "session_started", title: `Gemini CLI session started${data.model ? ` · ${data.model}` : ""}`, sessionId: typeof data.session_id === "string" ? data.session_id : undefined }];
      case "message":
        if (data.role === "assistant" && typeof data.content === "string") text += data.content;
        return [];
      case "tool_use": {
        const name = String(data.tool_name ?? "tool");
        const params = (data.parameters ?? {}) as Record<string, unknown>;
        const file = String(params.file_path ?? params.path ?? params.absolute_path ?? "");
        const event: EngineEvent = EDIT_TOOLS.has(name)
          ? { type: "file_edit", title: `Edited ${file || "a file"}` }
          : SHELL_TOOLS.has(name)
            ? { type: "command_run", title: String(params.command ?? "shell").slice(0, 200) }
            : { type: "tool_call", title: `${name}${file ? ` ${file}` : params.pattern ? ` ${String(params.pattern)}` : ""}` };
        return [...flush(), event];
      }
      case "error": {
        const message = String(data.message ?? "Gemini error");
        return [{ type: "error", title: message.slice(0, 200), reason: failureReason(message) ?? "engine_error" }];
      }
      case "result": {
        const stats = (data.stats ?? {}) as { input_tokens?: number; output_tokens?: number };
        const ok = data.status === "success";
        const errorText = typeof (data.error as { message?: string } | undefined)?.message === "string" ? (data.error as { message: string }).message : undefined;
        return [
          ...flush(),
          { type: "usage", title: "Token usage", usage: { tokensIn: stats.input_tokens ?? 0, tokensOut: stats.output_tokens ?? 0 } },
          { type: "done", title: ok ? "Gemini CLI finished" : `Gemini CLI ended: ${errorText?.slice(0, 160) ?? String(data.status)}`, detail: errorText, ok, reason: ok ? "completed" : failureReason(errorText) ?? "engine_error" },
        ];
      }
      default:
        return [];
    }
  };
}

export class GeminiEngine implements Engine {
  readonly name = "gemini";
  readonly label = "Gemini CLI";
  readonly supportsResume = false;
  private supervisor = new Supervisor();
  private flags: Record<string, boolean> | null = null;

  private async binary() {
    return process.env.MEADOW_GEMINI_BIN || (await findBinary(["gemini"]));
  }

  private async detectFlags(binary: string) {
    if (this.flags) return this.flags;
    const help = await capture(binary, ["--help"], { timeoutMs: 20_000 });
    const text = help.stdout + help.stderr;
    const flags: Record<string, boolean> = {};
    for (const flag of ["--output-format", "--yolo", "--approval-mode", "--model", "--prompt"]) flags[flag] = text.includes(flag);
    flags["stream-json"] = /stream-json/.test(text);
    this.flags = flags;
    return flags;
  }

  async doctor(): Promise<DoctorReport> {
    const report: DoctorReport = { engine: this.name, ready: false, version: null, checks: [], flags: {} };
    const binary = await this.binary();
    if (!binary) {
      report.checks.push({ name: "binary", ok: false, detail: "gemini was not found on PATH.", fix: "Install with: npm install -g @google/gemini-cli" });
      return report;
    }
    report.checks.push({ name: "binary", ok: true, detail: binary });
    report.version = (await capture(binary, ["--version"], { timeoutMs: 20_000 })).stdout.trim() || null;
    const flags = await this.detectFlags(binary);
    report.flags = flags;
    report.checks.push(flags["stream-json"] ? { name: "flags", ok: true, detail: "stream-json output supported" } : { name: "flags", ok: false, detail: "This gemini version has no stream-json output.", fix: "Update: npm install -g @google/gemini-cli" });
    const settings = path.join(os.homedir(), ".gemini", "settings.json");
    const authed = Boolean(getSecret("GEMINI_API_KEY")) || fs.existsSync(path.join(os.homedir(), ".gemini", "oauth_creds.json")) || fs.existsSync(settings);
    report.checks.push(authed ? { name: "auth", ok: true, detail: getSecret("GEMINI_API_KEY") ? "GEMINI_API_KEY set" : "Gemini CLI login found" } : { name: "auth", ok: false, detail: "No Gemini login found", fix: "Run `gemini` once to sign in, or put GEMINI_API_KEY in ~/.meadow/secrets.env." });
    report.ready = report.checks.every(check => check.ok);
    return report;
  }

  writeRules(cwd: string, rules: string) {
    const file = path.join(cwd, "GEMINI.md");
    const marker = "<!-- meadow-rules -->";
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const base = existing.includes(marker) ? existing.slice(0, existing.indexOf(marker)).trimEnd() : existing.trimEnd();
    fs.writeFileSync(file, `${base ? base + "\n\n" : ""}${marker}\n# Meadow project rules\n\n${rules}\n`);
  }

  async *run(req: RunRequest): AsyncIterable<EngineEvent> {
    const binary = await this.binary();
    if (!binary) {
      yield { type: "error", title: "gemini is not installed", reason: "missing_binary" };
      yield { type: "done", title: "Engine unavailable", ok: false, reason: "missing_binary" };
      return;
    }
    const flags = await this.detectFlags(binary);
    const args = ["--output-format", "stream-json"];
    if (!req.readonly) {
      if (flags["--approval-mode"]) args.push("--approval-mode", "yolo");
      else if (flags["--yolo"]) args.push("--yolo");
    }
    if (req.model && flags["--model"]) args.push("--model", req.model);
    args.push(flags["--prompt"] ? "--prompt" : "-p", req.prompt);
    const key = getSecret("GEMINI_API_KEY");
    const env = { ...req.env, ...(key ? { GEMINI_API_KEY: key } : {}) };
    yield* this.supervisor.start({ ...req, env }, binary, args, createGeminiParser());
  }

  cancel(runId: string) {
    return this.supervisor.cancel(runId);
  }
}
