import fs from "node:fs";
import path from "node:path";
import { homePath, loadConfig } from "../config";
import { capture } from "../core/exec";
import type { DoctorReport, Engine, EngineEvent, RunRequest } from "./base";
import { Supervisor } from "./supervisor";

/** Plain-text output: every non-empty line becomes an activity message. Exit code decides success. */
export function parsePlainLine(line: string): EngineEvent[] {
  const text = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return text ? [{ type: "message", title: text.slice(0, 200), detail: text }] : [];
}

/**
 * Runs any local coding CLI (aider, opencode, a script…). The command comes only from
 * ~/.meadow/config.json and receives the prompt as $MEADOW_PROMPT and $MEADOW_PROMPT_FILE.
 */
export class CustomEngine implements Engine {
  readonly name = "custom";
  readonly supportsResume = false;
  private supervisor = new Supervisor();

  get label() {
    return loadConfig().engine.custom.label || "Custom command";
  }

  private command() {
    return loadConfig().engine.custom.command.trim();
  }

  async doctor(): Promise<DoctorReport> {
    const report: DoctorReport = { engine: this.name, ready: false, version: null, checks: [], flags: {} };
    const command = this.command();
    if (!command) {
      report.checks.push({ name: "command", ok: false, detail: "No custom command configured.", fix: 'Set engine.custom.command in ~/.meadow/config.json, e.g. "aider --yes-always --message-file \\"$MEADOW_PROMPT_FILE\\"".' });
      return report;
    }
    const program = command.split(/\s+/)[0];
    const found = await capture("/bin/sh", ["-c", `command -v ${JSON.stringify(program)}`], { timeoutMs: 10_000 });
    report.checks.push(found.code === 0 ? { name: "command", ok: true, detail: `${program} → ${found.stdout.trim()}` } : { name: "command", ok: false, detail: `${program} was not found on PATH.`, fix: `Install ${program} or fix engine.custom.command.` });
    report.ready = report.checks.every(check => check.ok);
    return report;
  }

  async *run(req: RunRequest): AsyncIterable<EngineEvent> {
    const command = this.command();
    if (!command) {
      yield { type: "error", title: "No custom engine command configured", reason: "missing_binary" };
      yield { type: "done", title: "Engine unavailable", ok: false, reason: "missing_binary" };
      return;
    }
    const dir = homePath("prompts");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const promptFile = path.join(dir, `${req.runId}.md`);
    fs.writeFileSync(promptFile, req.prompt, { mode: 0o600 });
    const env = { ...req.env, MEADOW_PROMPT: req.prompt, MEADOW_PROMPT_FILE: promptFile, MEADOW_PROJECT_DIR: req.cwd, ...(req.model ? { MEADOW_MODEL: req.model } : {}) };
    yield { type: "session_started", title: `${this.label} started` };
    try {
      yield* this.supervisor.start({ ...req, env }, "/bin/sh", ["-c", command], parsePlainLine);
    } finally {
      fs.rmSync(promptFile, { force: true });
    }
  }

  cancel(runId: string) {
    return this.supervisor.cancel(runId);
  }
}
