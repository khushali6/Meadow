import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homePath, loadConfig } from "../config";
import { approvalAnswer, getApproval, requestApproval } from "../core/approvals";
import { audit } from "../core/audit";
import { networkEnv, runShell } from "../core/exec";
import { redact, tail } from "../core/redact";
import { getProject } from "../projects";
import { hasGrant } from "./grants";
import { classifyCommand } from "./policy";

/**
 * The broker runs as an MCP server started by the coding engine, so it may live inside the engine's sandbox. It
 * never runs privileged commands itself: it records a request, the user approves it (Telegram or dashboard), and the
 * Meadow process running the harness executes it outside the sandbox and writes the result back.
 */
export type BrokerRequest = { id: string; projectId: number; cwd: string; command: string; reason: string; kind: string; approvalId: number | null; granted: boolean; created: string };
export type BrokerResult = { status: "done" | "failed" | "denied" | "refused"; exitCode: number | null; output: string };

const dir = () => homePath("broker");
const requestFile = (id: string) => path.join(dir(), `${id}.request.json`);
const resultFile = (id: string) => path.join(dir(), `${id}.result.json`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export type AskResult = { answered: boolean; answer: string | null; note: string };

/** Asks the user on Telegram (and the dashboard) and waits for the answer. Unanswered questions expire. */
export async function askHuman(input: { projectId: number; question: string; options?: string[]; context?: string; pollMs?: number }): Promise<AskResult> {
  const options = (input.options ?? []).map(option => option.trim()).filter(Boolean).slice(0, 6);
  const { id } = requestApproval({ projectId: input.projectId, kind: "question", title: input.question.slice(0, 300), detail: [input.context?.slice(0, 1500), options.length ? `Options: ${options.join(" | ")}` : ""].filter(Boolean).join("\n\n"), detached: true, payload: { question: true, options } });
  audit({ projectId: input.projectId, agent: "engine", user: "engine", tool: "broker.ask_human", risk: "READ", args: input, approval: "pending", result: "pending", durationMs: 0, detail: input.question });
  while (true) {
    const row = getApproval(id);
    if (!row || row.status === "expired" || (row.status === "pending" && Date.parse(row.expires_at) < Date.now())) {
      return { answered: false, answer: null, note: "The user did not answer in time. Choose the safest reasonable option, say which one you chose and why in your final report, and keep going." };
    }
    if (row.status === "denied") return { answered: false, answer: null, note: "The user declined to answer. Choose the safest reasonable option and note the assumption in your final report." };
    if (row.status === "approved") {
      const answer = approvalAnswer(id);
      return { answered: true, answer, note: `The user answered: ${answer ?? "(no text)"}` };
    }
    await sleep(input.pollMs ?? 1500);
  }
}

/** Policy-checked system command: refused, left to the engine (allowed), or run by Meadow after approval. */
export async function requestSystemAction(input: { projectId: number; command: string; reason: string; pollMs?: number }): Promise<BrokerResult & { level: string; reason: string }> {
  const project = getProject(input.projectId);
  const verdict = classifyCommand(input.command, project.path);
  const base = { level: verdict.level, reason: verdict.reason };
  if (verdict.level === "forbidden") {
    audit({ projectId: project.id, agent: "engine", user: "engine", tool: `broker.system.${verdict.rule}`, risk: "DESTRUCTIVE", args: input, approval: "refused", result: "refused", durationMs: 0, detail: input.command });
    return { ...base, status: "refused", exitCode: null, output: `Refused: ${verdict.reason} Find another way that stays inside the project.` };
  }
  if (verdict.level === "allowed") return { ...base, status: "refused", exitCode: null, output: "This command is allowed inside the project. Run it yourself with your shell tool." };
  const kind = `system.${verdict.rule}`;
  const granted = hasGrant(project.id, kind);
  const approval = granted
    ? null
    : requestApproval({ projectId: project.id, kind, title: `Run on your computer: ${input.command.slice(0, 120)}`, detail: `${input.reason.slice(0, 600)}\n\n${verdict.reason}\nCommand: ${input.command}\nFolder: ${project.path}`, risk: "high", detached: true, payload: { remember: true, command: input.command } });
  const request: BrokerRequest = { id: crypto.randomUUID(), projectId: project.id, cwd: project.path, command: input.command, reason: input.reason, kind, approvalId: approval?.id ?? null, granted, created: new Date().toISOString() };
  writeJson(requestFile(request.id), request);
  const deadline = Date.now() + (loadConfig().approvals.expiryS + 30 * 60) * 1000;
  while (Date.now() < deadline) {
    const result = readJson<BrokerResult>(resultFile(request.id));
    if (result) {
      fs.rmSync(resultFile(request.id), { force: true });
      return { ...base, ...result };
    }
    await sleep(input.pollMs ?? 1500);
  }
  fs.rmSync(requestFile(request.id), { force: true });
  return { ...base, status: "denied", exitCode: null, output: "No decision arrived in time; the command was not run." };
}

let executor: NodeJS.Timeout | null = null;
const running = new Set<string>();

/** In the Meadow process that runs the harness: executes approved broker requests outside the engine's sandbox. */
export function startBrokerExecutor(intervalMs = 1000) {
  if (executor) return;
  executor = setInterval(() => void executeReady().catch(() => undefined), intervalMs);
  executor.unref();
}

export function stopBrokerExecutor() {
  if (executor) clearInterval(executor);
  executor = null;
}

export async function executeReady(): Promise<number> {
  if (!fs.existsSync(dir())) return 0;
  let handled = 0;
  for (const name of fs.readdirSync(dir()).filter(file => file.endsWith(".request.json"))) {
    const request = readJson<BrokerRequest>(path.join(dir(), name));
    if (!request || running.has(request.id)) continue;
    const finish = (result: BrokerResult) => {
      writeJson(resultFile(request.id), result);
      fs.rmSync(requestFile(request.id), { force: true });
      handled += 1;
    };
    const verdict = classifyCommand(request.command, request.cwd);
    if (verdict.level !== "approval") {
      finish({ status: "refused", exitCode: null, output: `Refused: ${verdict.reason}` });
      continue;
    }
    let approved = request.granted;
    if (!approved && request.approvalId !== null) {
      const row = getApproval(request.approvalId);
      if (!row || row.status === "pending") continue;
      approved = row.status === "approved";
      if (!approved) {
        audit({ projectId: request.projectId, agent: "engine", user: "owner", tool: `broker.${request.kind}`, risk: "HIGH_WRITE", args: { command: request.command }, approval: row.status === "expired" ? "expired" : "denied", result: "refused", durationMs: 0, detail: request.command });
        finish({ status: "denied", exitCode: null, output: row.status === "expired" ? "The approval expired; the command was not run." : "The user denied this; the command was not run. Find another way or explain what you need in your report." });
        continue;
      }
    }
    running.add(request.id);
    const started = Date.now();
    try {
      const result = await runShell(request.command, { cwd: request.cwd, timeoutS: 20 * 60, env: networkEnv() });
      const ok = result.exitCode === 0;
      audit({ projectId: request.projectId, agent: "engine", user: "owner", tool: `broker.${request.kind}`, risk: "HIGH_WRITE", args: { command: request.command }, approval: "approved", result: ok ? "ok" : "error", durationMs: Date.now() - started, detail: request.command });
      finish({ status: ok ? "done" : "failed", exitCode: result.exitCode, output: tail(redact(result.output), 60) });
    } finally {
      running.delete(request.id);
    }
  }
  return handled;
}
