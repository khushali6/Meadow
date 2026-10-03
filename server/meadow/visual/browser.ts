import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBinary, isWindows, killTree, minimalEnv, spawnGroup } from "../core/exec";

export type Viewport = { width: number; height: number; scale: number };

const exists = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Playwright's own browser downloads, if any project on this machine ever installed them. */
function playwrightCache(): string | null {
  const home = os.homedir();
  const standard = process.platform === "darwin" ? path.join(home, "Library", "Caches", "ms-playwright") : isWindows ? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ms-playwright") : path.join(home, ".cache", "ms-playwright");
  const names = new Set(["chrome-headless-shell", "chrome-headless-shell.exe", "headless_shell", "headless_shell.exe", "chrome", "chrome.exe", "Chromium", "Google Chrome for Testing"]);
  const builds: string[] = [];
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, standard]) {
    if (!root) continue;
    try {
      for (const name of fs.readdirSync(root)) if (/^chromium/.test(name)) builds.push(path.join(root, name));
    } catch {
      // Not there.
    }
  }
  // Headless shell first (it starts fastest and always exits), newest build first.
  builds.sort((a, b) => Number(path.basename(b).includes("headless")) - Number(path.basename(a).includes("headless")) || path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
  for (const build of builds) {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: build, depth: 0 }];
    while (queue.length) {
      const { dir: current, depth } = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isFile() && names.has(entry.name)) return full;
        if (entry.isDirectory() && depth < 5) queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}

/** A Chromium-based browser already on this machine: MEADOW_BROWSER, Chrome, Edge, Chromium, Brave, or Playwright's download. */
export async function findBrowser(): Promise<string | null> {
  const override = process.env.MEADOW_BROWSER;
  if (override) return exists(override) ? override : await findBinary([override]);
  const cached = playwrightCache();
  if (cached && /headless/.test(path.basename(cached))) return cached;
  const home = os.homedir();
  if (process.platform === "darwin") {
    const apps = [["Google Chrome", "Google Chrome"], ["Chromium", "Chromium"], ["Microsoft Edge", "Microsoft Edge"], ["Brave Browser", "Brave Browser"], ["Google Chrome Canary", "Google Chrome Canary"], ["Arc", "Arc"]];
    for (const root of ["/Applications", path.join(home, "Applications")]) for (const [app, bin] of apps) {
      const file = path.join(root, `${app}.app`, "Contents", "MacOS", bin);
      if (exists(file)) return file;
    }
  } else if (isWindows) {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((dir): dir is string => Boolean(dir));
    const rel = [["Google", "Chrome", "Application", "chrome.exe"], ["Microsoft", "Edge", "Application", "msedge.exe"], ["Chromium", "Application", "chrome.exe"], ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]];
    for (const root of roots) for (const parts of rel) {
      const file = path.join(root, ...parts);
      if (exists(file)) return file;
    }
  } else {
    const found = await findBinary(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"]);
    if (found) return found;
    for (const file of ["/snap/bin/chromium", "/usr/bin/chromium", "/usr/lib/chromium/chromium"]) if (exists(file)) return file;
  }
  return playwrightCache();
}

/**
 * Runs the browser until `done` reports the work is finished. Desktop Chrome on macOS writes the screenshot and then
 * keeps running (its updater and helpers hold it open), so waiting for the process to exit would hang.
 */
function run(browser: string, args: string[], timeoutMs: number, done: (stdout: string) => boolean): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawnGroup(browser, args, { cwd: os.tmpdir(), env: minimalEnv({ DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }) });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", chunk => (stdout = (stdout + chunk.toString()).slice(-2_000_000)));
    child.stderr?.on("data", chunk => (stderr = (stderr + chunk.toString()).slice(-20_000)));
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      killTree(child);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const poll = setInterval(() => {
      if (done(stdout)) setTimeout(() => finish(0), 300);
    }, 250);
    child.on("error", error => {
      stderr += error.message;
      finish(null);
    });
    child.on("close", code => finish(code));
  });
}

/**
 * Headless flags for a throwaway profile that can only reach the project's own localhost server:
 * every other host name resolves to nothing, so pages can't call out or leak anything.
 */
export function localOnlyArgs(profile: string): string[] {
  return [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--hide-scrollbars",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
    ...(process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : []),
  ];
}

function baseArgs(profile: string, viewport: Viewport): string[] {
  return [
    ...localOnlyArgs(profile),
    `--window-size=${viewport.width},${viewport.height}`,
    `--force-device-scale-factor=${viewport.scale}`,
    "--virtual-time-budget=10000",
  ];
}

/**
 * The page's served text, used to skip screenshots that would show a secret. Read over HTTP rather than with
 * --dump-dom: desktop Chrome only flushes that output when it exits, which it doesn't on macOS.
 */
export async function pageText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const html = (await response.text()).slice(0, 2_000_000);
    return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  } finally {
    clearTimeout(timer);
  }
}

/** The browser may still be writing to its profile for a moment after it's killed. */
function removeProfile(profile: string) {
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Left in the temp folder; the OS clears it.
  }
}

export async function browserScreenshot(browser: string, url: string, file: string, viewport: Viewport): Promise<void> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-browser-"));
  try {
    fs.rmSync(file, { force: true });
    let lastSize = -1;
    const written = () => {
      let size = -1;
      try {
        size = fs.statSync(file).size;
      } catch {
        return false;
      }
      const stable = size > 0 && size === lastSize;
      lastSize = size;
      return stable;
    };
    const result = await run(browser, [...baseArgs(profile, viewport), `--screenshot=${file}`, url], 60_000, written);
    if (!exists(file)) throw new Error(`the browser didn't write a screenshot${result.stderr ? `: ${result.stderr.trim().split("\n").pop()}` : ""}`);
  } finally {
    removeProfile(profile);
  }
}
