import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSecret } from "../config";
import { bus } from "../core/events";
import { capture, findBinary } from "../core/exec";

export type ServiceStatus = "ready" | "needs_login" | "not_running" | "not_installed" | "not_configured";
export type ConnectedService = { name: string; kind: "mcp" | "github" | "docker"; status: ServiceStatus; detail: string; fix: string | null };

/** MCP server names from Cursor's config files: names and transport only, never URLs' secrets or env values. */
export function configuredMcpServers(projectPath?: string): Array<{ name: string; transport: "http" | "stdio"; source: string }> {
  const files = [path.join(os.homedir(), ".cursor", "mcp.json"), ...(projectPath ? [path.join(projectPath, ".cursor", "mcp.json")] : [])];
  const found = new Map<string, { name: string; transport: "http" | "stdio"; source: string }>();
  for (const file of files) {
    try {
      const servers = (JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, { url?: string; command?: string }> }).mcpServers ?? {};
      for (const [name, server] of Object.entries(servers)) {
        if (name === "meadow") continue;
        found.set(name.toLowerCase(), { name: name.toLowerCase(), transport: server.url ? "http" : "stdio", source: file.startsWith(os.homedir()) && !projectPath?.startsWith(path.dirname(file)) ? "user" : "project" });
      }
    } catch {
      // Missing or unreadable config: nothing configured there.
    }
  }
  return [...found.values()];
}

/** Parses `agent mcp list` ("supabase: ready", "supabase: requires_authentication"). */
export function parseMcpList(output: string): Record<string, ServiceStatus> {
  const statuses: Record<string, ServiceStatus> = {};
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const match = line.match(/^\s*[•*-]?\s*([\w.-]+)\s*[:\-–]\s*(.+?)\s*$/);
    if (!match) continue;
    const state = match[2].toLowerCase();
    statuses[match[1].toLowerCase()] = /auth|login|sign/.test(state) ? "needs_login" : /ready|connected|ok|enabled|loaded/.test(state) ? "ready" : /disabled|not loaded/.test(state) ? "not_configured" : "not_running";
  }
  return statuses;
}

let mcpCache: { at: number; binary: string; statuses: Record<string, ServiceStatus> } | null = null;

async function cursorBinary() {
  return process.env.MEADOW_CURSOR_BIN || (await findBinary(["cursor-agent", "agent"]));
}

/** What the Cursor CLI (the engine) can actually use, as opposed to what the editor has connected. */
export async function engineMcpStatus(force = false): Promise<Record<string, ServiceStatus>> {
  const binary = await cursorBinary();
  if (!binary) return {};
  if (!force && mcpCache?.binary === binary && Date.now() - mcpCache.at < 60_000) return mcpCache.statuses;
  const result = await capture(binary, ["mcp", "list"], { cwd: os.tmpdir(), timeoutMs: 30_000 });
  const statuses = parseMcpList(`${result.stdout}\n${result.stderr}`);
  mcpCache = { at: Date.now(), binary, statuses };
  return statuses;
}

export async function dockerStatus(): Promise<{ status: ServiceStatus; detail: string }> {
  const binary = await findBinary(["docker"]);
  if (!binary) return { status: "not_installed", detail: "Docker is not installed." };
  const info = await capture(binary, ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 });
  return info.code === 0 && info.stdout.trim() ? { status: "ready", detail: `Docker ${info.stdout.trim()} is running.` } : { status: "not_running", detail: "Docker is installed but not running." };
}

export async function githubStatus(): Promise<{ status: ServiceStatus; detail: string }> {
  if (getSecret("GITHUB_TOKEN")) return { status: "ready", detail: "GitHub token saved (from the GitHub CLI or Setup)." };
  const gh = await findBinary(["gh"]);
  if (!gh) return { status: "not_configured", detail: "No GitHub token saved and the GitHub CLI is not installed." };
  return { status: "needs_login", detail: "The GitHub CLI is installed; run ./startup.sh and accept copying its login, or save a GITHUB_TOKEN in Setup." };
}

/** Every service Meadow can hand to the engine or use itself, with what to do when it isn't usable yet. */
export async function connectedServices(projectPath?: string): Promise<ConnectedService[]> {
  const [mcp, docker, github] = await Promise.all([engineMcpStatus(), dockerStatus(), githubStatus()]);
  const services: ConnectedService[] = [];
  const names = new Set([...configuredMcpServers(projectPath).map(server => server.name), ...Object.keys(mcp)]);
  for (const name of [...names].filter(item => item !== "meadow").sort()) {
    const status = mcp[name] ?? "not_configured";
    services.push({
      name,
      kind: "mcp",
      status,
      detail: status === "ready" ? `${name} is connected for the coding engine.` : status === "needs_login" ? `${name} is connected in Cursor but the Cursor CLI needs a one-time sign-in.` : `${name} is configured but not usable by the engine (${status.replace(/_/g, " ")}).`,
      fix: status === "needs_login" ? `Click Sign in next to ${name} in Meadow (or run: agent mcp login ${name}). Meadow reuses it for every project.` : status === "ready" ? null : `Check ${name} in Cursor Settings → MCP.`,
    });
  }
  services.push({ name: "github", kind: "github", status: github.status, detail: github.detail, fix: github.status === "ready" ? null : "Run ./startup.sh and accept the GitHub CLI login, or save GITHUB_TOKEN in Setup." });
  services.push({ name: "docker", kind: "docker", status: docker.status, detail: docker.detail, fix: docker.status === "not_running" ? "Start Docker Desktop." : docker.status === "not_installed" ? "Install Docker Desktop if a project needs containers." : null });
  return services;
}

/** One line per service for planner and engine prompts. */
export async function servicesSummary(projectPath?: string): Promise<string> {
  const services = await connectedServices(projectPath).catch(() => []);
  if (!services.length) return "Connected services: none detected.";
  return `Connected services: ${services.map(service => `${service.name} (${service.status.replace(/_/g, " ")})`).join(", ")}`;
}

const loginsRunning = new Set<string>();

/**
 * Starts the sign-in in the background after the user tapped Sign in, and posts the outcome as an event (which also
 * reaches Telegram). The browser opens on this computer.
 */
export function startMcpLogin(name: string, by: string): { started: boolean; detail: string } {
  if (!/^[\w.-]{1,60}$/.test(name)) throw new Error("Invalid service name.");
  if (loginsRunning.has(name)) return { started: false, detail: `Sign-in for ${name} is already waiting in your browser.` };
  loginsRunning.add(name);
  void loginMcp(name)
    .then(result => bus.emitEvent({ projectId: null, type: "setup", title: result.ok ? `${name} connected for the coding engine` : `${name} sign-in did not finish`, detail: result.detail, payload: { service: name, ok: result.ok, by } }))
    .catch(error => bus.emitEvent({ projectId: null, type: "setup", title: `${name} sign-in failed`, detail: (error as Error).message, payload: { service: name, ok: false, by } }))
    .finally(() => loginsRunning.delete(name));
  return { started: true, detail: `A browser window opened on your computer to sign ${name} in. Finish it there; Meadow remembers it for every project.` };
}

/** Starts the one-time sign-in for an MCP server in the Cursor CLI (opens the browser on this computer). */
export async function loginMcp(name: string): Promise<{ ok: boolean; detail: string }> {
  if (!/^[\w.-]{1,60}$/.test(name)) throw new Error("Invalid service name.");
  const binary = await cursorBinary();
  if (!binary) return { ok: false, detail: "The Cursor CLI is not installed." };
  const result = await capture(binary, ["mcp", "login", name], { cwd: os.tmpdir(), timeoutMs: 5 * 60_000 });
  mcpCache = null;
  const status = (await engineMcpStatus(true))[name.toLowerCase()];
  return status === "ready" ? { ok: true, detail: `${name} is signed in for the coding engine.` } : { ok: false, detail: (result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n") || `${name} still needs sign-in (${status ?? "unknown"}).` };
}
