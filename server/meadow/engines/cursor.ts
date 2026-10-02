import fs from "node:fs";
import path from "node:path";
import { getSecret } from "../config";
import { capture, findBinary } from "../core/exec";
import { failureReason, type DoctorReport, type Engine, type EngineEvent, type RunRequest } from "./base";
import { Supervisor } from "./supervisor";

const REQUIRED_FLAGS = ["--print", "--output-format"] as const;
const OPTIONAL_FLAGS = ["--force", "--trust", "--workspace", "--model", "--mode", "--resume", "--sandbox"] as const;

function toolTitle(toolCall: Record<string, unknown>): { type: EngineEvent["type"]; title: string; detail?: string } {
  const [kind, value] = Object.entries(toolCall)[0] ?? ["tool", {}];
  const args = ((value as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>;
  const file = String(args.path ?? args.filePath ?? args.file_path ?? args.targetFile ?? "");
  switch (kind) {
    case "writeToolCall":
    case "editToolCall":
    case "searchReplaceToolCall":
    case "applyPatchToolCall":
      return { type: "file_edit", title: `Edited ${file || "a file"}` };
    case "deleteToolCall":
      return { type: "file_edit", title: `Deleted ${file || "a file"}` };
    case "shellToolCall":
    case "terminalToolCall":
      return { type: "command_run", title: String(args.command ?? "shell command").slice(0, 200) };
    case "readToolCall":
      return { type: "tool_call", title: `Read ${file}` };
    case "grepToolCall":
      return { type: "tool_call", title: `Searched for ${String(args.pattern ?? "")}` };
    case "globToolCall":
    case "lsToolCall":
      return { type: "tool_call", title: `Listed ${String(args.path ?? args.globPattern ?? ".")}` };
    case "function": {
      const fn = value as { name?: string; arguments?: string };
      return { type: "tool_call", title: `Tool ${fn.name ?? "call"}`, detail: fn.arguments?.slice(0, 300) };
    }
    default:
      return { type: "tool_call", title: kind.replace(/ToolCall$/, "") };
  }
}

/** Parse one line of `cursor-agent --output-format stream-json`. Unknown line types are ignored, never fatal. */
export function parseCursorLine(line: string): EngineEvent[] {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line);
  } catch {
    return [];
  }
  const sessionId = typeof data.session_id === "string" ? data.session_id : undefined;
  switch (data.type) {
    case "system":
      return data.subtype === "init" ? [{ type: "session_started", title: `Cursor session started${data.model ? ` · ${data.model}` : ""}`, sessionId }] : [];
    case "assistant": {
      const content = ((data.message as { content?: Array<{ type: string; text?: string }> })?.content ?? []).filter(part => part.type === "text" && part.text?.trim());
      const text = content.map(part => part.text).join("");
      return text.trim() ? [{ type: "message", title: text.trim().split("\n")[0].slice(0, 160), detail: text.trim(), sessionId }] : [];
    }
    case "thinking":
      return data.subtype === "completed" ? [{ type: "thinking", title: "Thinking", detail: typeof data.text === "string" ? data.text : undefined }] : [];
    case "tool_call": {
      if (data.subtype !== "completed") return [];
      const info = toolTitle((data.tool_call ?? {}) as Record<string, unknown>);
      return [{ ...info, sessionId }];
    }
    case "result": {
      const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const events: EngineEvent[] = [];
      if (usage) events.push({ type: "usage", title: "Token usage", usage: { tokensIn: usage.input_tokens ?? 0, tokensOut: usage.output_tokens ?? 0 } });
      const ok = data.subtype === "success" && !data.is_error;
      const result = typeof data.result === "string" ? data.result : undefined;
      events.push({ type: "done", title: ok ? "Cursor finished" : "Cursor reported an error", detail: result, ok, reason: ok ? "completed" : failureReason(result) ?? "engine_error", sessionId });
      return events;
    }
    case "error":
      return [{ type: "error", title: String((data as { message?: string }).message ?? "Cursor error"), reason: failureReason(String((data as { message?: string }).message ?? "")) ?? "engine_error" }];
    default:
      return [];
  }
}

export class CursorEngine implements Engine {
  readonly name = "cursor";
  readonly label = "Cursor CLI";
  readonly supportsResume = true;
  private supervisor = new Supervisor();
  private flags: Record<string, boolean> | null = null;
  private binary: string | null = null;

  private async resolveBinary() {
    if (this.binary) return this.binary;
    this.binary = process.env.MEADOW_CURSOR_BIN || (await findBinary(["cursor-agent", "agent"]));
    return this.binary;
  }

  private async detectFlags(binary: string) {
    if (this.flags) return this.flags;
    const help = await capture(binary, ["--help"], { timeoutMs: 20_000 });
    const text = help.stdout + help.stderr;
    const flags: Record<string, boolean> = {};
    for (const flag of [...REQUIRED_FLAGS, ...OPTIONAL_FLAGS]) flags[flag] = new RegExp(`(^|\\s|,)${flag.replace(/-/g, "\\-")}(\\s|,|=|$)`, "m").test(text);
    flags["stream-json"] = /stream-json/.test(text);
    this.flags = flags;
    return flags;
  }

  async doctor(): Promise<DoctorReport> {
    const report: DoctorReport = { engine: this.name, ready: false, version: null, checks: [], flags: {} };
    const binary = await this.resolveBinary();
    if (!binary) {
      report.checks.push({ name: "binary", ok: false, detail: "cursor-agent was not found on PATH.", fix: "Install it with: curl https://cursor.com/install -fsS | bash" });
      return report;
    }
    report.checks.push({ name: "binary", ok: true, detail: binary });
    const version = await capture(binary, ["--version"], { timeoutMs: 20_000 });
    report.version = version.stdout.trim().split("\n")[0] || null;
    const flags = await this.detectFlags(binary);
    report.flags = flags;
    const missing = [...REQUIRED_FLAGS.filter(flag => !flags[flag]), ...(flags["stream-json"] ? [] : ["stream-json output"])];
    report.checks.push(missing.length ? { name: "flags", ok: false, detail: `This cursor-agent version lacks: ${missing.join(", ")}`, fix: "Run `cursor-agent update`." } : { name: "flags", ok: true, detail: `print + stream-json supported${flags["--force"] ? ", --force" : ""}${flags["--trust"] ? ", --trust" : ""}` });
    const status = await capture(binary, ["status"], { timeoutMs: 20_000 });
    const statusText = (status.stdout + status.stderr).trim();
    const loggedIn = status.code === 0 && !/not logged in|unauthenticated|log ?in required/i.test(statusText);
    const keySaved = !loggedIn && Boolean(getSecret("CURSOR_API_KEY"));
    report.checks.push(loggedIn || keySaved ? { name: "auth", ok: true, detail: keySaved ? "CURSOR_API_KEY saved (checked on the first run)" : statusText.split("\n")[0] || "Authenticated" } : { name: "auth", ok: false, detail: statusText.split("\n")[0] || "Not logged in", fix: "Open Setup → Coding engine and click Connect (or save a CURSOR_API_KEY there)." });
    report.ready = report.checks.every(check => check.ok);
    return report;
  }

  writeRules(cwd: string, rules: string) {
    const dir = path.join(cwd, ".cursor", "rules");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meadow.mdc"), `---\ndescription: Meadow project rules\nalwaysApply: true\n---\n\n${rules}\n`);
  }

  async *run(req: RunRequest): AsyncIterable<EngineEvent> {
    const binary = await this.resolveBinary();
    if (!binary) {
      yield { type: "error", title: "cursor-agent is not installed", reason: "missing_binary" };
      yield { type: "done", title: "Engine unavailable", ok: false, reason: "missing_binary" };
      return;
    }
    const flags = await this.detectFlags(binary);
    const args = ["--print", "--output-format", "stream-json"];
    if (flags["--trust"]) args.push("--trust");
    if (flags["--workspace"]) args.push("--workspace", req.cwd);
    if (req.readonly) {
      if (flags["--mode"]) args.push("--mode", "ask");
    } else if (flags["--force"]) {
      args.push("--force");
    }
    if (req.model && flags["--model"]) args.push("--model", req.model);
    if (req.sessionId && flags["--resume"]) args.push("--resume", req.sessionId);
    args.push(req.prompt);
    yield* this.supervisor.start(req, binary, args, parseCursorLine);
  }

  cancel(runId: string) {
    return this.supervisor.cancel(runId);
  }
}
