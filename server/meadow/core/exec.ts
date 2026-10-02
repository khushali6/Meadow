import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";

export const isWindows = process.platform === "win32";

/**
 * On Windows, npm-installed CLIs are `.cmd` shims that Node refuses to spawn without a shell (since 20.12).
 * cross-spawn resolves the shim and escapes every argument for cmd.exe, so prompts can't break out.
 */
const spawn = (command: string, args: string[], options: SpawnOptions): ChildProcess => (isWindows && !options.shell ? crossSpawn(command, args, options) : nodeSpawn(command, args, options));

const BASE_ENV_ALLOW = ["PATH", "Path", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "WINDIR", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "BUN_INSTALL"];

/** A minimal environment allowlist: the user's full environment (and its secrets) never reaches child processes. */
export function minimalEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_ALLOW) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  // Windows env names are case-insensitive; pick up "SystemRoot", "ComSpec" etc. whatever their casing.
  if (isWindows) {
    const wanted = new Set(BASE_ENV_ALLOW.map(key => key.toUpperCase()));
    for (const [key, value] of Object.entries(process.env)) if (value && wanted.has(key.toUpperCase()) && !(key.toUpperCase() in env)) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  env.CI = env.CI ?? "1";
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  return env;
}

const NETWORK_ENV_ALLOW = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSH_AUTH_SOCK", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "GIT_SSL_CAINFO", "PIP_INDEX_URL", "npm_config_registry", "GOPROXY"];

/** minimalEnv plus what network tools need to work behind proxies and with SSH agents (clone, dependency installs). */
export function networkEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const picked: Record<string, string | undefined> = {};
  for (const key of NETWORK_ENV_ALLOW) picked[key] = process.env[key];
  return minimalEnv({ ...picked, ...extra });
}

export function spawnGroup(command: string, args: string[], options: { cwd: string; env: Record<string, string>; shell?: boolean }): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell ?? false,
    detached: !isWindows,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Kill the child and its whole process group so no orphans survive. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (isWindows) {
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
  if (signal !== "SIGKILL") {
    const timer = setTimeout(() => killTree(child, "SIGKILL"), 3000);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }
}

export type ShellResult = { exitCode: number | null; output: string; timedOut: boolean; durationMs: number };

/** Run a shell command (a plan check, a preview, git…) with a timeout and process-group cleanup. */
export function runShell(command: string, options: { cwd: string; timeoutS: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<ShellResult> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawnGroup(command, [], { cwd: options.cwd, env: options.env ?? minimalEnv(), shell: true });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutS * 1000);
    const onAbort = () => killTree(child);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", error => {
      output += `\n${error.message}`;
    });
    child.on("close", code => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: timedOut ? null : code, output, timedOut, durationMs: Date.now() - started });
    });
  });
}

export function which(binary: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = nodeSpawn(isWindows ? "where" : "which", [binary], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", chunk => (out += chunk.toString()));
    child.on("error", () => resolve(null));
    child.on("close", code => {
      const lines = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (code !== 0 || !lines.length) return resolve(null);
      // `where` lists every match; the extensionless one (a POSIX script) can't run on Windows.
      const runnable = isWindows ? lines.find(line => /\.(exe|cmd|bat|com)$/i.test(line)) : undefined;
      resolve(runnable ?? lines[0]);
    });
  });
}

/** Per-user and package-manager bin folders that a daemon started from a desktop launcher often lacks on PATH. */
export function extraBinDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return [path.join(local, "cursor-agent"), path.join(local, "Programs", "cursor-agent"), path.join(roaming, "npm"), path.join(local, "pnpm"), path.join(home, ".bun", "bin"), path.join(home, ".local", "bin")];
  }
  return [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".volta", "bin"), path.join(home, "Library", "pnpm"), path.join(home, ".local", "share", "pnpm"), path.join(home, ".claude", "local")];
}

/** The first of `names` on PATH, else in a well-known install folder. */
export async function findBinary(names: string[]): Promise<string | null> {
  for (const name of names) {
    const found = await which(name);
    if (found) return found;
  }
  const suffixes = isWindows ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of extraBinDirs()) {
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, name + suffix);
        try {
          fs.accessSync(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // Not here.
        }
      }
    }
  }
  return null;
}

export function capture(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    if (!child.stdout || !child.stderr) return resolve({ code: null, stdout: "", stderr: `Could not start ${command}` });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk.toString()));
    child.stderr.on("data", chunk => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 20_000);
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + error.message });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
