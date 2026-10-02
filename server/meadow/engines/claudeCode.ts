import fs from "node:fs";
import path from "node:path";
import { getSecret, loadConfig } from "../config";
import { capture, which } from "../core/exec";
import type { DoctorReport, Engine, EngineEvent, RunRequest } from "./base";
import { Supervisor } from "./supervisor";

/** Parse one line of `claude -p --output-format stream-json --verbose`. */
export function parseClaudeLine(line: string): EngineEvent[] {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line);
  } catch {
    return [];
  }
  const sessionId = typeof data.session_id === "string" ? data.session_id : undefined;
  if (data.type === "system" && data.subtype === "init") return [{ type: "session_started", title: `Claude Code session started${data.model ? ` · ${data.model}` : ""}`, sessionId }];
  if (data.type === "assistant") {
    const events: EngineEvent[] = [];
    const content = ((data.message as { content?: Array<Record<string, unknown>> })?.content ?? []);
    for (const part of content) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) events.push({ type: "message", title: part.text.trim().split("\n")[0].slice(0, 160), detail: part.text.trim(), sessionId });
      if (part.type === "thinking") events.push({ type: "thinking", title: "Thinking" });
      if (part.type === "tool_use") {
        const input = (part.input ?? {}) as Record<string, unknown>;
        const name = String(part.name ?? "tool");
        const file = String(input.file_path ?? input.path ?? input.notebook_path ?? "");
        if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) events.push({ type: "file_edit", title: `Edited ${file || "a file"}`, sessionId });
        else if (name === "Bash") events.push({ type: "command_run", title: String(input.command ?? "shell").slice(0, 200), sessionId });
        else events.push({ type: "tool_call", title: `${name}${file ? ` ${file}` : input.pattern ? ` ${String(input.pattern)}` : ""}`, sessionId });
      }
    }
    return events;
  }
  if (data.type === "result") {
    const usage = data.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    const events: EngineEvent[] = [];
    if (usage) events.push({ type: "usage", title: "Token usage", usage: { tokensIn: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), tokensOut: usage.output_tokens ?? 0, costUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined } });
    const ok = data.subtype === "success" && !data.is_error;
    events.push({ type: "done", title: ok ? "Claude Code finished" : `Claude Code ended: ${String(data.subtype)}`, detail: typeof data.result === "string" ? data.result : undefined, ok, reason: ok ? "completed" : "engine_error", sessionId });
    return events;
  }
  return [];
}

export class ClaudeCodeEngine implements Engine {
  readonly name = "claude_code";
  readonly label = "Claude Code";
  readonly supportsResume = true;
  private supervisor = new Supervisor();
  private flags: Record<string, boolean> | null = null;

  private async binary() {
    return process.env.MEADOW_CLAUDE_BIN || (await which("claude"));
  }

  private async detectFlags(binary: string) {
    if (this.flags) return this.flags;
    const help = await capture(binary, ["--help"], { timeoutMs: 20_000 });
    const text = help.stdout + help.stderr;
    const flags: Record<string, boolean> = {};
    for (const flag of ["--print", "--output-format", "--verbose", "--permission-mode", "--resume", "--model", "--dangerously-skip-permissions"]) flags[flag] = text.includes(flag);
    flags.bypassPermissions = /bypassPermissions/.test(text);
    this.flags = flags;
    return flags;
  }

  private viaGateway() {
    return loadConfig().engine.claudeUseFreeLlmApi;
  }

  async doctor(): Promise<DoctorReport> {
    const report: DoctorReport = { engine: this.name, ready: false, version: null, checks: [], flags: {} };
    const binary = await this.binary();
    if (!binary) {
      report.checks.push({ name: "binary", ok: false, detail: "claude was not found on PATH.", fix: "Install with: npm install -g @anthropic-ai/claude-code" });
      return report;
    }
    report.checks.push({ name: "binary", ok: true, detail: binary });
    report.version = (await capture(binary, ["--version"], { timeoutMs: 20_000 })).stdout.trim() || null;
    const flags = await this.detectFlags(binary);
    report.flags = flags;
    const missing = ["--print", "--output-format", "--verbose"].filter(flag => !flags[flag]);
    report.checks.push(missing.length ? { name: "flags", ok: false, detail: `Missing flags: ${missing.join(", ")}`, fix: "Update Claude Code." } : { name: "flags", ok: true, detail: "print + stream-json supported" });
    if (this.viaGateway()) {
      report.checks.push(getSecret("FREELLMAPI_API_KEY") ? { name: "auth", ok: true, detail: "Routed through local FreeLLMAPI gateway" } : { name: "auth", ok: false, detail: "FREELLMAPI_API_KEY missing", fix: "Run `meadow init`." });
    } else {
      report.checks.push({ name: "auth", ok: true, detail: "Uses your Claude Code login (checked on first run)" });
    }
    report.ready = report.checks.every(check => check.ok);
    return report;
  }

  writeRules(cwd: string, rules: string) {
    const file = path.join(cwd, "CLAUDE.md");
    const marker = "<!-- meadow-rules -->";
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const base = existing.includes(marker) ? existing.slice(0, existing.indexOf(marker)).trimEnd() : existing.trimEnd();
    fs.writeFileSync(file, `${base ? base + "\n\n" : ""}${marker}\n# Meadow project rules\n\n${rules}\n`);
  }

  async *run(req: RunRequest): AsyncIterable<EngineEvent> {
    const binary = await this.binary();
    if (!binary) {
      yield { type: "error", title: "claude is not installed", reason: "missing_binary" };
      yield { type: "done", title: "Engine unavailable", ok: false, reason: "missing_binary" };
      return;
    }
    const flags = await this.detectFlags(binary);
    const args = ["--print", "--output-format", "stream-json", "--verbose"];
    if (req.readonly) args.push("--permission-mode", "plan");
    else if (flags.bypassPermissions) args.push("--permission-mode", "bypassPermissions");
    else if (flags["--dangerously-skip-permissions"]) args.push("--dangerously-skip-permissions");
    if (req.model && flags["--model"]) args.push("--model", req.model);
    if (req.sessionId && flags["--resume"]) args.push("--resume", req.sessionId);
    args.push(req.prompt);
    const env = { ...req.env };
    if (this.viaGateway()) {
      env.ANTHROPIC_BASE_URL = loadConfig().llm.baseUrl.replace(/\/v1\/?$/, "");
      env.ANTHROPIC_AUTH_TOKEN = getSecret("FREELLMAPI_API_KEY") ?? "";
    }
    yield* this.supervisor.start({ ...req, env }, binary, args, parseClaudeLine);
  }

  cancel(runId: string) {
    return this.supervisor.cancel(runId);
  }
}
