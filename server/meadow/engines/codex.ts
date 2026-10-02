import fs from "node:fs";
import path from "node:path";
import { getSecret } from "../config";
import { capture, minimalEnv, which } from "../core/exec";
import { failureReason, type DoctorReport, type Engine, type EngineEvent, type RunRequest } from "./base";
import { Supervisor } from "./supervisor";

type CodexItem = { type?: string; text?: string; command?: string; exit_code?: number | null; status?: string; changes?: Array<{ path?: string; kind?: string }>; server?: string; tool?: string; query?: string };

/** Parse one line of `codex exec --json` (thread/turn/item JSONL events). */
export function parseCodexLine(line: string): EngineEvent[] {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line);
  } catch {
    return [];
  }
  switch (data.type) {
    case "thread.started":
      return [{ type: "session_started", title: "Codex session started", sessionId: typeof data.thread_id === "string" ? data.thread_id : undefined }];
    case "item.completed": {
      const item = (data.item ?? {}) as CodexItem;
      switch (item.type) {
        case "agent_message":
          return item.text?.trim() ? [{ type: "message", title: item.text.trim().split("\n")[0].slice(0, 160), detail: item.text.trim() }] : [];
        case "reasoning":
          return [{ type: "thinking", title: "Thinking" }];
        case "command_execution":
          return [{ type: "command_run", title: String(item.command ?? "shell").slice(0, 200), detail: item.exit_code === undefined || item.exit_code === null ? undefined : `exit ${item.exit_code}` }];
        case "file_change":
          return (item.changes ?? []).map(change => ({ type: "file_edit" as const, title: `${change.kind === "delete" ? "Deleted" : change.kind === "add" ? "Created" : "Edited"} ${change.path ?? "a file"}` }));
        case "mcp_tool_call":
          return [{ type: "tool_call", title: `${item.server ?? "mcp"}.${item.tool ?? "tool"}` }];
        case "web_search":
          return [{ type: "tool_call", title: `Web search ${item.query ?? ""}`.trim() }];
        case "error":
          return [{ type: "error", title: String(item.text ?? "Codex error").slice(0, 200), reason: failureReason(item.text) ?? "engine_error" }];
        default:
          return [];
      }
    }
    case "turn.completed": {
      const usage = data.usage as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined;
      const events: EngineEvent[] = [];
      if (usage) events.push({ type: "usage", title: "Token usage", usage: { tokensIn: usage.input_tokens ?? 0, tokensOut: usage.output_tokens ?? 0 } });
      events.push({ type: "done", title: "Codex finished", ok: true, reason: "completed" });
      return events;
    }
    case "turn.failed": {
      const message = String((data.error as { message?: string } | undefined)?.message ?? "Codex turn failed");
      return [{ type: "done", title: `Codex ended: ${message.slice(0, 160)}`, detail: message, ok: false, reason: failureReason(message) ?? "engine_error" }];
    }
    case "error": {
      const message = String(data.message ?? "Codex error");
      return [{ type: "error", title: message.slice(0, 200), reason: failureReason(message) ?? "engine_error" }];
    }
    default:
      return [];
  }
}

export class CodexEngine implements Engine {
  readonly name = "codex";
  readonly label = "Codex CLI";
  readonly supportsResume = true;
  private supervisor = new Supervisor();
  private flags: Record<string, boolean> | null = null;

  private async binary() {
    return process.env.MEADOW_CODEX_BIN || (await which("codex"));
  }

  private async detectFlags(binary: string) {
    if (this.flags) return this.flags;
    const help = await capture(binary, ["exec", "--help"], { timeoutMs: 20_000 });
    const text = help.stdout + help.stderr;
    const flags: Record<string, boolean> = {};
    for (const flag of ["--json", "--experimental-json", "--sandbox", "--cd", "--model", "--skip-git-repo-check", "--full-auto"]) flags[flag] = text.includes(flag);
    flags.resume = /\bresume\b/.test(text);
    this.flags = flags;
    return flags;
  }

  async doctor(): Promise<DoctorReport> {
    const report: DoctorReport = { engine: this.name, ready: false, version: null, checks: [], flags: {} };
    const binary = await this.binary();
    if (!binary) {
      report.checks.push({ name: "binary", ok: false, detail: "codex was not found on PATH.", fix: "Install with: npm install -g @openai/codex" });
      return report;
    }
    report.checks.push({ name: "binary", ok: true, detail: binary });
    report.version = (await capture(binary, ["--version"], { timeoutMs: 20_000 })).stdout.trim() || null;
    const flags = await this.detectFlags(binary);
    report.flags = flags;
    report.checks.push(flags["--json"] || flags["--experimental-json"] ? { name: "flags", ok: true, detail: "exec --json supported" } : { name: "flags", ok: false, detail: "This codex version has no `exec --json`.", fix: "Update Codex: npm install -g @openai/codex" });
    const status = await capture(binary, ["login", "status"], { timeoutMs: 20_000, env: minimalEnv({ OPENAI_API_KEY: getSecret("OPENAI_API_KEY") }) });
    const text = (status.stdout + status.stderr).trim();
    const loggedIn = status.code === 0 && !/not logged in/i.test(text);
    report.checks.push(loggedIn ? { name: "auth", ok: true, detail: text.split("\n")[0] || "Logged in" } : { name: "auth", ok: false, detail: text.split("\n")[0] || "Not logged in", fix: "Run `codex login`." });
    report.ready = report.checks.every(check => check.ok);
    return report;
  }

  writeRules(cwd: string, rules: string) {
    const file = path.join(cwd, "AGENTS.md");
    const marker = "<!-- meadow-rules -->";
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const base = existing.includes(marker) ? existing.slice(0, existing.indexOf(marker)).trimEnd() : existing.trimEnd();
    fs.writeFileSync(file, `${base ? base + "\n\n" : ""}${marker}\n# Meadow project rules\n\n${rules}\n`);
  }

  async *run(req: RunRequest): AsyncIterable<EngineEvent> {
    const binary = await this.binary();
    if (!binary) {
      yield { type: "error", title: "codex is not installed", reason: "missing_binary" };
      yield { type: "done", title: "Engine unavailable", ok: false, reason: "missing_binary" };
      return;
    }
    const flags = await this.detectFlags(binary);
    const args = ["exec"];
    if (req.sessionId && flags.resume) args.push("resume", req.sessionId);
    args.push(flags["--json"] ? "--json" : "--experimental-json");
    if (flags["--sandbox"]) args.push("--sandbox", req.readonly ? "read-only" : "workspace-write");
    if (flags["--cd"]) args.push("--cd", req.cwd);
    if (flags["--skip-git-repo-check"]) args.push("--skip-git-repo-check");
    if (req.model && flags["--model"]) args.push("--model", req.model);
    args.push(req.prompt);
    const key = getSecret("OPENAI_API_KEY");
    const env = { ...req.env, ...(key ? { OPENAI_API_KEY: key } : {}) };
    yield* this.supervisor.start({ ...req, env }, binary, args, parseCodexLine);
  }

  cancel(runId: string) {
    return this.supervisor.cancel(runId);
  }
}
