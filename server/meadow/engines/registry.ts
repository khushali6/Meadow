import { loadConfig, type EngineName } from "../config";
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

export type EngineStatus = "available" | "coming_soon" | "disabled";

/** Engines listed here keep their adapters but cannot be selected. */
const ENGINE_STATUS: Partial<Record<string, EngineStatus>> = { claude_code: "coming_soon" };

export class EngineUnavailableError extends Error {
  constructor(readonly code: "ENGINE_COMING_SOON" | "ENGINE_DISABLED" | "ENGINE_UNKNOWN", message: string) {
    super(message);
  }
}

export function engineStatus(name: string): EngineStatus {
  return ENGINE_STATUS[name] ?? (engines.has(name) ? "available" : "disabled");
}

export function engineInfo() {
  return Array.from(engines.keys()).map(name => ({ name, label: engineLabel(name), status: engineStatus(name) }));
}

/** Throws a structured error unless the engine exists and can be selected. */
export function assertSelectableEngine(name: string): void {
  if (!engines.has(name)) throw new EngineUnavailableError("ENGINE_UNKNOWN", `Unknown engine "${name}". Available: ${selectableEngines().join(", ")}`);
  const status = engineStatus(name);
  if (status === "coming_soon") throw new EngineUnavailableError("ENGINE_COMING_SOON", `${engineLabel(name)} is coming soon and is not available yet.`);
  if (status === "disabled") throw new EngineUnavailableError("ENGINE_DISABLED", `${engineLabel(name)} is disabled.`);
}

export function selectableEngines(): string[] {
  return Array.from(engines.keys()).filter(name => engineStatus(name) === "available");
}

/** The configured default engine, or the first available one when the default can't be selected. */
export function effectiveDefaultEngine(): string {
  const configured = loadConfig().engine.default;
  if (engineStatus(configured) === "available") return configured;
  return selectableEngines().find(name => name !== "fake") ?? "fake";
}

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
  return Promise.all(Array.from(engines.values()).map(engine => engineStatus(engine.name) !== "available"
    ? Promise.resolve<DoctorReport>({ engine: engine.name, ready: false, version: null, checks: [{ name: "availability", ok: false, detail: `${engine.label} is coming soon.` }], flags: {}, status: engineStatus(engine.name) })
    : engine.doctor().catch(error => ({ engine: engine.name, ready: false, version: null, checks: [{ name: "doctor", ok: false, detail: (error as Error).message }], flags: {} }))));
}
