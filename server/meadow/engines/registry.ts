import type { EngineName } from "../config";
import type { DoctorReport, Engine } from "./base";
import { ClaudeCodeEngine } from "./claudeCode";
import { CodexEngine } from "./codex";
import { CursorEngine } from "./cursor";
import { CustomEngine } from "./custom";
import { FakeEngine } from "./fake";
import { GeminiEngine } from "./gemini";

const engines = new Map<string, Engine>();

function register(engine: Engine) {
  engines.set(engine.name, engine);
}

register(new CursorEngine());
register(new ClaudeCodeEngine());
register(new CodexEngine());
register(new GeminiEngine());
register(new CustomEngine());
register(new FakeEngine());

export const ENGINE_LABELS: Record<EngineName, string> = { cursor: "Cursor CLI", claude_code: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI", custom: "Custom command", fake: "Fake engine (demo)" };

export function engineLabel(name: string): string {
  return engines.get(name)?.label ?? ENGINE_LABELS[name as EngineName] ?? name;
}

export function getEngine(name: string): Engine {
  const engine = engines.get(name);
  if (!engine) throw new Error(`Unknown engine "${name}". Available: ${Array.from(engines.keys()).join(", ")}`);
  return engine;
}

export function setEngine(engine: Engine) {
  engines.set(engine.name, engine);
}

export function engineNames() {
  return Array.from(engines.keys());
}

export async function doctorAll(): Promise<DoctorReport[]> {
  return Promise.all(Array.from(engines.values()).map(engine => engine.doctor().catch(error => ({ engine: engine.name, ready: false, version: null, checks: [{ name: "doctor", ok: false, detail: (error as Error).message }], flags: {} }))));
}
