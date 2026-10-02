import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSecret, saveConfig, setSecret, type SecretName } from "../config";
import { capture, findBinary, isWindows, killTree, networkEnv, spawnGroup } from "../core/exec";
import { tail } from "../core/redact";
import type { DoctorReport } from "../engines/base";
import { effectiveDefaultEngine, engineLabel, engineStatus, getEngine, type EngineStatus } from "../engines/registry";
import { getProject, updateProject } from "../projects";

type Platform = "mac" | "win" | "linux";
type Command = { program: string; args: string[]; display: string; needs: string | null };

type EngineDef = {
  name: string;
  binaries: string[];
  binEnv: string;
  /** Desktop apps that mean the user already has an account with this vendor. */
  apps: Partial<Record<Platform, string[]>>;
  install: (platform: Platform) => Command | null;
  /** Arguments for a browser sign-in that works without a terminal; null when the CLI only signs in interactively. */
  loginArgs: string[] | null;
  key: SecretName | null;
  keyHint: string;
  keyHelp: string;
};

const platform: Platform = process.platform === "darwin" ? "mac" : isWindows ? "win" : "linux";
const local = () => process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

const npmInstall = (pkg: string): Command => ({ program: "npm", args: ["install", "-g", pkg], display: `npm install -g ${pkg}`, needs: "npm" });

export const ENGINE_DEFS: EngineDef[] = [
  {
    name: "cursor",
    binaries: ["cursor-agent", "agent"],
    binEnv: "MEADOW_CURSOR_BIN",
    apps: { mac: ["Cursor.app"], win: [path.join("Programs", "cursor", "Cursor.exe")], linux: ["cursor"] },
    install: p => (p === "win"
      ? { program: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm 'https://cursor.com/install?win32=true' | iex"], display: "irm 'https://cursor.com/install?win32=true' | iex", needs: null }
      : { program: "sh", args: ["-c", "curl https://cursor.com/install -fsS | bash"], display: "curl https://cursor.com/install -fsS | bash", needs: "curl" }),
    loginArgs: ["login"],
    key: "CURSOR_API_KEY",
    keyHint: "key_…",
    keyHelp: "Cursor dashboard → Integrations → API keys",
  },
  {
    name: "codex",
    binaries: ["codex"],
    binEnv: "MEADOW_CODEX_BIN",
    apps: { mac: ["Codex.app"] },
    install: () => npmInstall("@openai/codex"),
    loginArgs: ["login"],
    key: "OPENAI_API_KEY",
    keyHint: "sk-…",
    keyHelp: "platform.openai.com → API keys",
  },
  {
    name: "gemini",
    binaries: ["gemini"],
    binEnv: "MEADOW_GEMINI_BIN",
    apps: {},
    install: () => npmInstall("@google/gemini-cli"),
    loginArgs: null,
    key: "GEMINI_API_KEY",
    keyHint: "AIza…",
    keyHelp: "aistudio.google.com → Get API key",
  },
  {
    name: "claude_code",
    binaries: ["claude"],
    binEnv: "MEADOW_CLAUDE_BIN",
    apps: { mac: ["Claude.app"], win: [path.join("AnthropicClaude", "claude.exe")] },
    install: () => npmInstall("@anthropic-ai/claude-code"),
    loginArgs: null,
    key: "ANTHROPIC_API_KEY",
    keyHint: "sk-ant-…",
    keyHelp: "console.anthropic.com → API keys",
  },
];

const EDITORS: Array<{ name: string; apps: Partial<Record<Platform, string[]>> }> = [
  { name: "Cursor", apps: { mac: ["Cursor.app"], win: [path.join("Programs", "cursor", "Cursor.exe")], linux: ["cursor"] } },
  { name: "VS Code", apps: { mac: ["Visual Studio Code.app"], win: [path.join("Programs", "Microsoft VS Code", "Code.exe")], linux: ["code"] } },
  { name: "Windsurf", apps: { mac: ["Windsurf.app"], win: [path.join("Programs", "Windsurf", "Windsurf.exe")], linux: ["windsurf"] } },
  { name: "Zed", apps: { mac: ["Zed.app"], linux: ["zed", "zeditor"] } },
  { name: "Claude", apps: { mac: ["Claude.app"], win: [path.join("AnthropicClaude", "claude.exe")] } },
  { name: "Codex", apps: { mac: ["Codex.app"] } },
];

async function appFound(apps: Partial<Record<Platform, string[]>>): Promise<boolean> {
  const names = apps[platform] ?? [];
  for (const name of names) {
    if (platform === "mac" && [path.join("/Applications", name), path.join(os.homedir(), "Applications", name)].some(dir => fs.existsSync(dir))) return true;
    if (platform === "win" && fs.existsSync(path.join(local(), name))) return true;
    if (platform === "linux" && (await findBinary([name]))) return true;
  }
  return false;
}

function defFor(name: string): EngineDef {
  const def = ENGINE_DEFS.find(item => item.name === name);
  if (!def) throw new EngineSetupError(`Meadow can't set up "${name}" from here.`);
  return def;
}

async function binaryFor(def: EngineDef) {
  return process.env[def.binEnv] || (await findBinary(def.binaries));
}

export class EngineSetupError extends Error {}

type Job = { kind: "login" | "install"; status: "running" | "done" | "failed"; detail: string; url: string | null; child: ChildProcess | null; startedAt: number };
const jobs = new Map<string, Job>();

export type EngineOption = {
  name: string;
  label: string;
  status: EngineStatus;
  installed: boolean;
  binary: string | null;
  version: string | null;
  signedIn: boolean;
  ready: boolean;
  detail: string;
  app: boolean;
  install: { command: string; needs: string | null; missing: string | null } | null;
  canLogin: boolean;
  key: SecretName | null;
  keySet: boolean;
  keyHint: string;
  keyHelp: string;
  job: { kind: Job["kind"]; status: Job["status"]; detail: string; url: string | null } | null;
};

export type EngineScan = { engines: EngineOption[]; recommended: string | null; selected: string; editors: string[] };

function summarize(report: DoctorReport): { signedIn: boolean; ready: boolean; detail: string } {
  const auth = report.checks.find(check => check.name === "auth");
  const failing = report.checks.find(check => !check.ok);
  return { signedIn: Boolean(auth?.ok), ready: report.ready, detail: failing ? failing.detail : auth?.detail ?? "Ready" };
}

async function option(def: EngineDef): Promise<EngineOption> {
  const status = engineStatus(def.name);
  const binary = await binaryFor(def);
  const app = await appFound(def.apps);
  const install = def.install(platform);
  const missing = install?.needs && !(await findBinary([install.needs])) ? `${install.needs} is not installed` : null;
  const job = jobs.get(def.name);
  const base = {
    name: def.name,
    label: engineLabel(def.name),
    status,
    binary,
    installed: Boolean(binary),
    app,
    install: install ? { command: install.display, needs: install.needs, missing } : null,
    canLogin: Boolean(def.loginArgs),
    key: def.key,
    keySet: Boolean(def.key && getSecret(def.key)),
    keyHint: def.keyHint,
    keyHelp: def.keyHelp,
    job: job ? { kind: job.kind, status: job.status, detail: job.detail, url: job.url } : null,
  };
  if (status !== "available") return { ...base, version: null, signedIn: false, ready: false, detail: binary ? `Installed at ${binary}; Meadow support is coming soon` : "Coming soon" };
  if (!binary) return { ...base, version: null, signedIn: false, ready: false, detail: app ? `${engineLabel(def.name)} isn't installed yet, but the desktop app is; install the CLI to connect` : "Not installed" };
  const report = await getEngine(def.name).doctor().catch(error => ({ engine: def.name, ready: false, version: null, checks: [{ name: "doctor", ok: false, detail: (error as Error).message }], flags: {} }) as DoctorReport);
  return { ...base, version: report.version, ...summarize(report) };
}

/** Every coding engine Meadow knows, with what's installed, signed in and ready on this computer. */
export async function scanEngines(): Promise<EngineScan> {
  const engines = await Promise.all(ENGINE_DEFS.map(option));
  const editors = (await Promise.all(EDITORS.map(async editor => ((await appFound(editor.apps)) ? editor.name : null)))).filter((name): name is string => Boolean(name));
  const selected = effectiveDefaultEngine();
  const usable = engines.filter(engine => engine.status === "available");
  const recommended = usable.find(engine => engine.name === selected && engine.ready)?.name ?? usable.find(engine => engine.ready)?.name ?? usable.find(engine => engine.installed)?.name ?? usable.find(engine => engine.app)?.name ?? usable[0]?.name ?? null;
  return { engines, recommended, selected, editors };
}

/** Variables a CLI needs to open the user's browser on every desktop. */
function browserEnv() {
  const pick = ["DISPLAY", "WAYLAND_DISPLAY", "BROWSER", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  return networkEnv(Object.fromEntries(pick.map(key => [key, process.env[key]])));
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

function runJob(name: string, kind: Job["kind"], command: Command, timeoutMs: number, onExit: (code: number | null, output: string) => Promise<{ ok: boolean; detail: string }>) {
  const running = jobs.get(name);
  if (running?.status === "running") return running;
  const job: Job = { kind, status: "running", detail: kind === "login" ? "Opening the sign-in page in your browser…" : `Running ${command.display}`, url: null, child: null, startedAt: Date.now() };
  jobs.set(name, job);
  let output = "";
  let child: ChildProcess;
  try {
    child = spawnGroup(command.program, command.args, { cwd: os.homedir(), env: browserEnv() });
  } catch (error) {
    job.status = "failed";
    job.detail = (error as Error).message;
    return job;
  }
  job.child = child;
  const onData = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-20_000);
    const url = output.match(/https:\/\/[^\s"'<>]+/)?.[0];
    if (kind === "login" && url && !job.url) {
      job.url = url;
      job.detail = "Finish signing in in your browser. Meadow connects as soon as you're done.";
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const timer = setTimeout(() => {
    output += `\n${kind === "login" ? "Sign-in" : "Install"} timed out.`;
    killTree(child);
  }, timeoutMs);
  child.on("error", error => (output += `\n${error.message}`));
  child.on("close", code => {
    clearTimeout(timer);
    job.child = null;
    void onExit(code, output).then(result => {
      job.status = result.ok ? "done" : "failed";
      job.detail = result.detail;
    });
  });
  return job;
}

/** Starts the engine's own browser sign-in and marks the engine connected once its doctor sees the login. */
export async function connectEngine(name: string) {
  const def = defFor(name);
  if (engineStatus(name) !== "available") throw new EngineSetupError(`${engineLabel(name)} is coming soon.`);
  const binary = await binaryFor(def);
  if (!binary) throw new EngineSetupError(`${engineLabel(name)} isn't installed yet. Click Install first.`);
  if (!def.loginArgs) throw new EngineSetupError(`${engineLabel(name)} only signs in from its own terminal UI. Paste an API key instead.`);
  const job = runJob(name, "login", { program: binary, args: def.loginArgs, display: `${path.basename(binary)} ${def.loginArgs.join(" ")}`, needs: null }, LOGIN_TIMEOUT_MS, async (code, output) => {
    const report = await getEngine(name).doctor();
    const { signedIn, detail } = summarize(report);
    if (signedIn) return { ok: true, detail: `Signed in · ${report.checks.find(check => check.name === "auth")?.detail ?? "connected"}` };
    return { ok: false, detail: code === 0 ? detail : `Sign-in did not finish: ${tail(output, 3).trim() || `exit ${code}`}` };
  });
  return { status: job.status, detail: job.detail, url: job.url };
}

/** Installs the engine CLI with the vendor's documented command. Only runs on an explicit click. */
export async function installEngine(name: string) {
  const def = defFor(name);
  if (engineStatus(name) !== "available") throw new EngineSetupError(`${engineLabel(name)} is coming soon.`);
  const command = def.install(platform);
  if (!command) throw new EngineSetupError(`Install ${engineLabel(name)} from its website, then click Scan again.`);
  if (command.needs && !(await findBinary([command.needs]))) throw new EngineSetupError(`Installing ${engineLabel(name)} needs ${command.needs}, which isn't installed.`);
  const job = runJob(name, "install", command, INSTALL_TIMEOUT_MS, async (code, output) => {
    const binary = await binaryFor(def);
    if (binary) return { ok: true, detail: `Installed at ${binary}${def.loginArgs ? ". Click Connect to sign in." : ""}` };
    return { ok: false, detail: code === 0 ? "Installed, but the command isn't on PATH yet. Open a new terminal or restart Meadow, then Scan again." : `Install failed: ${tail(output, 3).trim() || `exit ${code}`}` };
  });
  return { status: job.status, detail: job.detail };
}

export function engineJob(name: string) {
  const job = jobs.get(name);
  return job ? { kind: job.kind, status: job.status, detail: job.detail, url: job.url } : null;
}

export function cancelEngineJob(name: string) {
  const job = jobs.get(name);
  if (job?.child) killTree(job.child);
  jobs.delete(name);
}

/** Saves the engine's API key to secrets.env. Codex also needs it registered with its own login store. */
export async function saveEngineKey(name: string, key: string) {
  const def = defFor(name);
  if (!def.key) throw new EngineSetupError(`${engineLabel(name)} doesn't use an API key.`);
  const value = key.trim();
  if (value.length < 8 || /\s/.test(value)) throw new EngineSetupError("That doesn't look like an API key.");
  setSecret(def.key, value);
  if (name === "codex") {
    const binary = await binaryFor(def);
    if (binary) {
      const result = await capture(binary, ["login", "--with-api-key"], { input: value, env: browserEnv(), timeoutMs: 30_000 });
      if (result.code !== 0) throw new EngineSetupError(`Codex rejected the key: ${tail(result.stderr || result.stdout, 2).trim()}`);
    }
  }
  return { saved: true };
}

/** Makes the engine the default and moves the setup project onto it. */
export function selectEngine(name: string, projectId: number | null) {
  if (engineStatus(name) !== "available") throw new EngineSetupError(`${engineLabel(name)} can't be selected yet.`);
  saveConfig({ engine: { default: name } });
  if (projectId) {
    getProject(projectId);
    updateProject(projectId, { engine: name });
  }
  return { selected: name };
}

/** Throws a clear error when the engine can't run (not installed or not signed in), before any branch is created. */
export async function assertEngineReady(name: string) {
  const report = await getEngine(name).doctor();
  const blocking = report.checks.find(check => !check.ok && ["binary", "auth"].includes(check.name));
  if (blocking) throw new EngineSetupError(`${engineLabel(name)} isn't connected: ${blocking.detail}. Open Setup → Coding engine to connect it.`);
}
