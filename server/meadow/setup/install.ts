import fs from "node:fs";
import path from "node:path";
import { capture, networkEnv, which } from "../core/exec";
import { tail } from "../core/redact";
import { getSetting, putSetting } from "../core/settings";
import { getProject } from "../projects";
import { detectProject } from "./detect";

export type InstallStep = { dir: string; label: string; program: string; args: string[]; missing: string | null };
export type InstallResult = { dir: string; label: string; command: string; ok: boolean; skipped: boolean; output: string; durationMs: number };

const isWindows = process.platform === "win32";
const has = (dir: string, file: string) => fs.existsSync(path.join(dir, file));
const venvPython = (dir: string) => path.join(dir, ".venv", isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python");
export const commandLine = (step: Pick<InstallStep, "program" | "args">) => [step.program.replace(/^.*[\\/](\.venv[\\/])/, "$1"), ...step.args].map(part => (/\s/.test(part) ? `"${part}"` : part)).join(" ");

/**
 * Dependency installs for the root and every package folder, using the tool each lockfile asks for. Python gets a
 * project-local .venv (never the system interpreter). Steps whose tool isn't installed are listed with a hint.
 */
export async function installPlan(root: string): Promise<InstallStep[]> {
  const profile = detectProject(root);
  const dirs = ["", ...profile.packages];
  const steps: InstallStep[] = [];
  const tool = async (name: string, hint: string) => ((await which(name)) ? null : hint);
  const python = (await which(isWindows ? "python" : "python3")) ? (isWindows ? "python" : "python3") : (await which("python")) ? "python" : null;
  for (const rel of dirs) {
    const dir = path.join(root, rel);
    const label = rel || "root";
    if (has(dir, "package.json") && !(rel && (has(root, "pnpm-workspace.yaml") || has(root, "lerna.json")))) {
      if (has(dir, "pnpm-lock.yaml") || has(dir, "pnpm-workspace.yaml")) steps.push({ dir: rel, label, program: "pnpm", args: ["install", "--frozen-lockfile"], missing: await tool("pnpm", "Install pnpm: npm install -g pnpm (or corepack enable)") });
      else if (has(dir, "yarn.lock")) steps.push({ dir: rel, label, program: "yarn", args: ["install", "--frozen-lockfile"], missing: await tool("yarn", "Install yarn: npm install -g yarn (or corepack enable)") });
      else if (has(dir, "bun.lockb") || has(dir, "bun.lock")) steps.push({ dir: rel, label, program: "bun", args: ["install", "--frozen-lockfile"], missing: await tool("bun", "Install bun from bun.sh") });
      else steps.push({ dir: rel, label, program: "npm", args: has(dir, "package-lock.json") ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"], missing: await tool("npm", "Install Node.js from nodejs.org") });
    }
    if (has(dir, "uv.lock")) steps.push({ dir: rel, label, program: "uv", args: ["sync"], missing: await tool("uv", "Install uv from docs.astral.sh/uv") });
    else if (has(dir, "poetry.lock")) steps.push({ dir: rel, label, program: "poetry", args: ["install"], missing: await tool("poetry", "Install poetry from python-poetry.org") });
    else if (has(dir, "requirements.txt") || has(dir, "pyproject.toml")) {
      const missing = python ? null : isWindows ? "Install Python from python.org (tick “Add to PATH”)" : "Install Python 3 (brew install python, apt install python3-venv, …)";
      if (!fs.existsSync(venvPython(dir))) steps.push({ dir: rel, label: `${label} (virtualenv)`, program: python ?? "python3", args: ["-m", "venv", ".venv"], missing });
      steps.push({ dir: rel, label, program: venvPython(dir), args: has(dir, "requirements.txt") ? ["-m", "pip", "install", "-q", "-r", "requirements.txt"] : ["-m", "pip", "install", "-q", "-e", "."], missing });
    }
    if (has(dir, "go.mod")) steps.push({ dir: rel, label, program: "go", args: ["mod", "download"], missing: await tool("go", "Install Go from go.dev/dl") });
    if (has(dir, "Cargo.toml") && !rel) steps.push({ dir: rel, label, program: "cargo", args: ["fetch"], missing: await tool("cargo", "Install Rust from rustup.rs") });
    if (has(dir, "Gemfile")) steps.push({ dir: rel, label, program: "bundle", args: ["install"], missing: await tool("bundle", "Install Ruby and bundler") });
    if (has(dir, "composer.json")) steps.push({ dir: rel, label, program: "composer", args: ["install", "--no-interaction"], missing: await tool("composer", "Install Composer from getcomposer.org") });
  }
  return steps;
}

const key = (projectId: number) => `install:${projectId}`;
export const lastInstall = (projectId: number) => getSetting<{ at: string; results: InstallResult[] }>(key(projectId)) ?? null;

/** Runs the plan in order with a network-capable minimal environment. A failed step doesn't stop the others. */
export async function runInstall(projectId: number, onProgress: (detail: string) => void = () => undefined): Promise<InstallResult[]> {
  const project = getProject(projectId);
  const results: InstallResult[] = [];
  for (const step of await installPlan(project.path)) {
    const command = commandLine(step);
    if (step.missing) {
      results.push({ dir: step.dir, label: step.label, command, ok: false, skipped: true, output: step.missing, durationMs: 0 });
      continue;
    }
    onProgress(`${step.label}: ${command}`);
    const started = Date.now();
    const result = await capture(step.program, step.args, { cwd: path.join(project.path, step.dir), env: networkEnv({ CI: "1" }), timeoutMs: 15 * 60_000 });
    results.push({ dir: step.dir, label: step.label, command, ok: result.code === 0, skipped: false, output: tail(`${result.stdout}\n${result.stderr}`.trim(), 30, 1500), durationMs: Date.now() - started });
  }
  putSetting(key(projectId), { at: new Date().toISOString(), results });
  return results;
}
