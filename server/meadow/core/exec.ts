import { spawn, type ChildProcess } from "node:child_process";

const isWindows = process.platform === "win32";

const BASE_ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "BUN_INSTALL"];

/** A minimal environment allowlist: the user's full environment (and its secrets) never reaches child processes. */
export function minimalEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_ALLOW) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  env.CI = env.CI ?? "1";
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  return env;
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
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
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
    const child = spawn(isWindows ? "where" : "which", [binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", chunk => (out += chunk.toString()));
    child.on("error", () => resolve(null));
    child.on("close", code => resolve(code === 0 ? out.trim().split("\n")[0] : null));
  });
}

export function capture(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
