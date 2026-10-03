import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { findBinary, isWindows, killTree, minimalEnv, networkEnv, runShell, spawnGroup } from "../core/exec";
import { isInside } from "../core/paths";
import type { Plan } from "../planning/format";
import { PreviewHandle, startPreview } from "./preview";

/** How to run a project so it can be opened in a browser. `how` is shown to the user as "run it yourself" instructions. */
export type LaunchSpec =
  | { kind: "plan"; how: string; routes: string[]; plan: NonNullable<Plan["preview"]> }
  | { kind: "command"; how: string; routes: string[]; command: string; install: string | null; port: number; readyTimeoutS: number; injectPort?: boolean }
  | { kind: "static"; how: string; routes: string[]; dir: string };

const readJson = (file: string): Record<string, any> | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const readHead = (file: string): string => {
  try {
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  }
};

const has = (dir: string, ...parts: string[]) => fs.existsSync(path.join(dir, ...parts));
const quote = (value: string) => (/[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No free port"))));
    });
  });
}

async function nodeLaunch(root: string, port: number): Promise<LaunchSpec | null> {
  for (const sub of ["", "web", "client", "frontend", "app", path.join("apps", "web")]) {
    const dir = path.join(root, sub);
    const scripts = readJson(path.join(dir, "package.json"))?.scripts as Record<string, string> | undefined;
    const script = scripts && ["dev", "start", "serve", "preview"].find(name => typeof scripts[name] === "string" && !/^\s*(echo|exit)\b/.test(scripts[name]));
    if (!script) continue;
    const manager = has(dir, "pnpm-lock.yaml") || has(root, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") || has(root, "yarn.lock") ? "yarn" : has(dir, "bun.lockb") || has(dir, "bun.lock") ? "bun" : "npm";
    const bin = (await findBinary([manager])) ? manager : "npm";
    const cd = sub ? `cd ${quote(sub)} && ` : "";
    const run = bin === "yarn" ? `yarn ${script}` : `${bin} run ${script}`;
    return { kind: "command", how: `${cd}${run}`, routes: ["/"], command: `${cd}${run}`, install: has(dir, "node_modules") ? null : `${cd}${bin} install`, port, readyTimeoutS: 180, injectPort: false };
  }
  return null;
}

async function pythonBin(root: string): Promise<string | null> {
  for (const venv of [".venv", "venv", "env"]) {
    const file = isWindows ? path.join(root, venv, "Scripts", "python.exe") : path.join(root, venv, "bin", "python");
    if (fs.existsSync(file)) return file;
  }
  return findBinary(isWindows ? ["python", "py", "python3"] : ["python3", "python"]);
}

async function pythonLaunch(root: string, port: number): Promise<LaunchSpec | null> {
  const files = ["manage.py", "app.py", "main.py", "streamlit_app.py", "server.py", "wsgi.py", path.join("app", "main.py"), path.join("src", "main.py"), path.join("src", "app.py")].filter(file => has(root, file));
  if (!files.length) return null;
  const py = await pythonBin(root);
  if (!py) return null;
  const run = (args: string) => ({ kind: "command" as const, how: `${path.basename(py)} ${args}`, routes: ["/"], command: `${quote(py)} ${args}`, install: null, port, readyTimeoutS: 120 });
  if (files.includes("manage.py")) return run(`manage.py runserver 127.0.0.1:${port} --noreload`);
  for (const file of files) {
    const text = readHead(path.join(root, file));
    const module = file.replace(/\.py$/, "").split(path.sep).join(".");
    if (/^\s*import streamlit|^\s*from streamlit/m.test(text)) return run(`-m streamlit run ${quote(file)} --server.port ${port} --server.address 127.0.0.1 --server.headless true`);
    const fastapi = text.match(/^(\w+)\s*=\s*FastAPI\(/m);
    if (fastapi) return run(`-m uvicorn ${module}:${fastapi[1]} --host 127.0.0.1 --port ${port}`);
    const flask = text.match(/^(\w+)\s*=\s*Flask\(/m);
    if (flask) return run(`-m flask --app ${module}:${flask[1]} run --host 127.0.0.1 --port ${port}`);
  }
  return null;
}

async function otherLaunch(root: string, port: number): Promise<LaunchSpec | null> {
  if (has(root, "bin", "rails") && (await findBinary(["ruby"]))) return { kind: "command", how: "bin/rails server", routes: ["/"], command: `ruby bin/rails server -b 127.0.0.1 -p ${port}`, install: null, port, readyTimeoutS: 120 };
  if (has(root, "index.php") && (await findBinary(["php"]))) return { kind: "command", how: `php -S 127.0.0.1:${port}`, routes: ["/"], command: `php -S 127.0.0.1:${port}`, install: null, port, readyTimeoutS: 30 };
  return null;
}

function staticLaunch(root: string): LaunchSpec | null {
  for (const sub of ["dist", "build", "out", "public", "docs", "site", "www", ""]) {
    if (has(root, sub, "index.html")) return { kind: "static", how: `open ${path.join(sub, "index.html") || "index.html"} in a browser`, routes: ["/"], dir: path.join(root, sub) };
  }
  return null;
}

/** The plan's preview block when it has one, else whatever this project looks like it runs with. Null for CLIs and libraries. */
export async function detectLaunch(root: string, plan: Plan | null): Promise<LaunchSpec | null> {
  if (plan?.preview) return { kind: "plan", how: plan.preview.command, routes: plan.preview.routes, plan: plan.preview };
  const port = await freePort();
  return (await nodeLaunch(root, port)) ?? (await pythonLaunch(root, port)) ?? (await otherLaunch(root, port)) ?? staticLaunch(root);
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain" };

/** Serves a folder on 127.0.0.1 only; requests can't leave the folder, and unknown paths fall back to index.html (single-page apps). */
export async function serveStatic(dir: string): Promise<PreviewHandle> {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    let file = path.join(dir, pathname);
    if (!isInside(dir, file)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) file = path.join(dir, "index.html");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
  return new PreviewHandle(`http://127.0.0.1:${port}/`, null, () => "", () => server.close());
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'`)\]\x1b]*)?/g;

/** Local URLs a dev server printed (Vite, Next, Django…), with 0.0.0.0 turned into something a browser can open. */
export function printedUrls(output: string): string[] {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const urls = (clean.match(LOCAL_URL) ?? []).map(url => url.replace("0.0.0.0", "127.0.0.1").replace(/\[::\]/, "127.0.0.1").replace(/[.,;:]+$/, ""));
  return [...new Set(urls)];
}

async function probe(url: string): Promise<{ ok: boolean; html: boolean }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    const html = /text\/html/i.test(response.headers.get("content-type") ?? "");
    await response.body?.cancel();
    return { ok: response.status < 500, html };
  } catch {
    return { ok: false, html: false };
  }
}

/**
 * Starts the project's app and resolves once a page answers. Prefers an HTML page: with `pnpm dev` starting
 * both an API (on PORT) and a Vite client (on its own printed port), the client is what a person would open.
 */
export async function launchApp(spec: LaunchSpec, cwd: string, onProgress: (detail: string) => void = () => undefined): Promise<PreviewHandle> {
  if (spec.kind === "plan") return startPreview(spec.plan, cwd);
  if (spec.kind === "static") return serveStatic(spec.dir);
  if (spec.install) {
    onProgress(`Installing dependencies (${spec.install})`);
    const installed = await runShell(spec.install, { cwd, timeoutS: 900, env: networkEnv() });
    if (installed.exitCode !== 0) throw new Error(`${spec.install} failed:\n${installed.output.slice(-1500)}`);
  }
  onProgress(`Starting the app (${spec.how})`);
  // Node apps run exactly as a person would run them, so port clashes and hardcoded ports show up here too.
  const injectPort = spec.injectPort !== false;
  const child = spawnGroup(spec.command, [], { cwd, env: minimalEnv({ ...(injectPort ? { PORT: String(spec.port), HOST: "127.0.0.1" } : {}), BROWSER: "none" }), shell: true });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-40_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let exited = false;
  child.on("close", () => (exited = true));
  const deadline = Date.now() + spec.readyTimeoutS * 1000;
  let fallback: { url: string; since: number } | null = null;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`The app exited before it was ready:\n${output.slice(-2000)}`);
    const mentioned = [...output.replace(/\x1b\[[0-9;]*m/g, "").matchAll(/\bport\s*:?\s*(\d{4,5})\b/gi)].map(match => `http://localhost:${match[1]}/`);
    const candidates = [...new Set([...printedUrls(output), ...mentioned, ...(injectPort ? [`http://127.0.0.1:${spec.port}/`, `http://localhost:${spec.port}/`] : [])])];
    for (const url of candidates) {
      const result = await probe(url);
      if (result.ok && result.html) return new PreviewHandle(url, child, () => output);
      if (result.ok && !fallback) fallback = { url, since: Date.now() };
    }
    if (fallback && Date.now() - fallback.since > 15_000) return new PreviewHandle(fallback.url, child, () => output);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  killTree(child);
  throw new Error(`The app didn't answer within ${spec.readyTimeoutS}s:\n${output.slice(-2000)}`);
}
