import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homePath, loadConfig } from "../config";
import { bus, type MeadowEvent } from "../core/events";
import { findBinary, minimalEnv } from "../core/exec";
import { getProject, type ProjectRow } from "../projects";

const LOGGED = new Set(["execution_started", "execution_finished", "phase_started", "session_started", "thinking", "message", "tool_call", "file_edit", "command_run", "check_result", "guard", "error", "phase_passed", "phase_blocked", "control", "approval_requested", "console_line"]);

const LABELS: Record<string, string> = {
  execution_started: "RUN   ", execution_finished: "RUN   ", phase_started: "PHASE ", session_started: "ENGINE", thinking: "THINK ",
  message: "SAY   ", tool_call: "TOOL  ", file_edit: "EDIT  ", command_run: "SHELL ", check_result: "CHECK ", guard: "GUARD ",
  error: "ERROR ", phase_passed: "PASS  ", phase_blocked: "BLOCK ", control: "RUN   ", approval_requested: "ASK   ", console_line: "RAW>  ",
};

export function liveLogPath(project: Pick<ProjectRow, "name">): string {
  return homePath("logs", "live", `${project.name}.log`);
}

export function formatLiveLine(event: MeadowEvent): string | null {
  if (!LOGGED.has(event.type)) return null;
  // Raw engine lines go to the log without a timestamp so they look like live terminal output.
  if (event.type === "console_line") return `RAW>  ${event.title}\n`;
  const time = new Date(event.ts).toLocaleTimeString([], { hour12: false });
  const detail = event.detail.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 200) ?? "";
  const rule = event.type === "phase_started" || event.type === "execution_started" ? `\n${"─".repeat(72)}\n` : "";
  return `${rule}${time}  ${LABELS[event.type] ?? event.type}  ${event.title}${detail && detail !== event.title ? `  · ${detail}` : ""}\n`;
}

/** Variables a GUI launcher needs on every desktop; nothing else from the daemon's environment. */
function desktopEnv() {
  const pick = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CURRENT_DESKTOP", "LOCALAPPDATA", "APPDATA", "ProgramFiles", "COMSPEC"];
  return minimalEnv(Object.fromEntries(pick.map(key => [key, process.env[key]])));
}

function launch(command: string, args: string[], options: { verbatim?: boolean; shell?: boolean } = {}): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false, env: desktopEnv(), windowsVerbatimArguments: options.verbatim, shell: options.shell });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

const EDITOR_ORDER: Record<string, Array<{ bin: string; app: string; label: string }>> = {
  cursor: [{ bin: "cursor", app: "Cursor", label: "Cursor" }],
  default: [
    { bin: "code", app: "Visual Studio Code", label: "VS Code" },
    { bin: "cursor", app: "Cursor", label: "Cursor" },
    { bin: "windsurf", app: "Windsurf", label: "Windsurf" },
  ],
};

/** Opens the project folder in the editor that matches the engine (Cursor for the Cursor CLI), so edits show up live. */
export async function openEditor(project: Pick<ProjectRow, "path" | "engine">): Promise<string | null> {
  const choices = project.engine === "cursor" ? [...EDITOR_ORDER.cursor, ...EDITOR_ORDER.default.filter(item => item.bin !== "cursor")] : EDITOR_ORDER.default;
  for (const choice of choices) {
    if (process.platform === "darwin" && [path.join("/Applications", `${choice.app}.app`), path.join(os.homedir(), "Applications", `${choice.app}.app`)].some(dir => fs.existsSync(dir))) {
      if (await launch("open", ["-a", choice.app, project.path])) return choice.label;
    }
    const bin = await findBinary([choice.bin]);
    if (bin && (await launch(bin, [project.path], { shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(bin) }))) return choice.label;
  }
  return null;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Opens a terminal window that follows the live log. Closing it never affects the run. */
export async function openLiveTerminal(project: Pick<ProjectRow, "name">, file = liveLogPath(project)): Promise<boolean> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  const banner = `Meadow live output for ${project.name}. Closing this window does not stop the run.`;
  if (process.platform === "win32") {
    const literal = file.replace(/'/g, "''");
    return launch(process.env.COMSPEC || "cmd.exe", ["/c", `start "Meadow ${project.name}" powershell -NoExit -NoProfile -Command "Write-Host '${banner.replace(/'/g, "''")}'; Get-Content -Wait -Tail 200 -LiteralPath '${literal}'"`], { verbatim: true });
  }
  const script = `clear; printf '\\033]0;Meadow · %s\\007' ${shellQuote(project.name)}; echo ${shellQuote(banner)}; echo; tail -n 200 -F ${shellQuote(file)}`;
  if (process.platform === "darwin") {
    const apple = script.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return launch("osascript", ["-e", `tell application "Terminal" to do script "${apple}"`, "-e", `tell application "Terminal" to activate`]);
  }
  const terminals: Array<[string, string[]]> = [
    ["x-terminal-emulator", ["-e", "sh", "-c", script]],
    ["gnome-terminal", ["--", "sh", "-c", script]],
    ["konsole", ["-e", "sh", "-c", script]],
    ["xfce4-terminal", ["-x", "sh", "-c", script]],
    ["kitty", ["sh", "-c", script]],
    ["alacritty", ["-e", "sh", "-c", script]],
    ["xterm", ["-e", "sh", "-c", script]],
  ];
  for (const [bin, args] of terminals) if ((await findBinary([bin])) && (await launch(bin, args))) return true;
  return false;
}

/** Opens whatever the user asked for; returns what was opened so callers can report it. */
export async function openWatchWindows(projectId: number, want = loadConfig().watch): Promise<{ editor: string | null; terminal: boolean }> {
  const project = getProject(projectId);
  const [editor, terminal] = await Promise.all([want.editor ? openEditor(project) : null, want.terminal ? openLiveTerminal(project) : false]);
  return { editor, terminal };
}

const windowsDisabled = () => Boolean(process.env.MEADOW_NO_WINDOWS || process.env.VITEST || process.env.CI);

/**
 * Writes a readable live log per project and, when a new run starts, opens the editor and a terminal following it.
 * A resumed run keeps its execution id, so it doesn't open a second set of windows.
 */
export function startWatch(): () => void {
  const opened = new Set<number>();
  return bus.onEvent(event => {
    if (!event.projectId) return;
    const line = formatLiveLine(event);
    let project: ProjectRow;
    try {
      project = getProject(event.projectId);
    } catch {
      return;
    }
    if (line) {
      try {
        const file = liveLogPath(project);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line);
      } catch {
        // The live log is a convenience view; the database keeps every event.
      }
    }
    if (event.type !== "execution_started" || !event.executionId || opened.has(event.executionId) || windowsDisabled()) return;
    opened.add(event.executionId);
    const want = loadConfig().watch;
    if (!want.editor && !want.terminal) return;
    void openWatchWindows(project.id, want).then(({ editor, terminal }) => {
      const parts = [editor ? `opened the project in ${editor}` : null, terminal ? "opened a terminal with the live engine output" : null].filter(Boolean);
      if (parts.length) bus.emitEvent({ type: "message", projectId: project.id, executionId: event.executionId, title: `Watching: ${parts.join(" and ")}`, detail: `Live log: ${liveLogPath(project)}` });
    });
  });
}
