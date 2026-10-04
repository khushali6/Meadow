import fs from "node:fs";
import path from "node:path";
import { getSecret, homePath, loadConfig } from "../config";
import * as git from "../core/git";
import { capture } from "../core/exec";

/** GitHub's API, or a local stand-in for tests. Anything else is refused so the token can't be sent elsewhere. */
function apiBase(): string {
  const custom = process.env.MEADOW_GITHUB_API;
  if (!custom) return "https://api.github.com";
  const url = new URL(custom);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("MEADOW_GITHUB_API must point at localhost.");
  return custom.replace(/\/$/, "");
}

const marker = (projectId: number) => homePath("github", `${projectId}.json`);

export function meadowCreatedRepo(projectId: number): { cloneUrl: string; htmlUrl: string; fullName: string } | null {
  try {
    return JSON.parse(fs.readFileSync(marker(projectId), "utf8"));
  } catch {
    return null;
  }
}

async function api<T>(token: string, method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${apiBase()}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "meadow", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, data: (await response.json().catch(() => ({}))) as T };
}

const validClone = (url: string) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(url) || (process.env.MEADOW_GITHUB_API !== undefined && (path.isAbsolute(url) || url.startsWith("file:")));

/**
 * A private GitHub repository for a project that has no remote yet. Never touches a project that already has an
 * `origin`, never makes anything public, and records which repositories it created so only those get pushed.
 */
export async function ensureGithubRepo(project: { id: number; name: string; path: string; description?: string | null }): Promise<{ status: "exists" | "created" | "skipped"; detail: string; url?: string }> {
  const remotes = (await git.git(project.path, "remote").catch(() => "")).split("\n").filter(Boolean);
  if (remotes.includes("origin")) return { status: "exists", detail: "The project already has an origin remote; Meadow leaves it alone." };
  if (!loadConfig().services.github.createRepo) return { status: "skipped", detail: "Creating GitHub repositories is turned off in Settings." };
  const token = getSecret("GITHUB_TOKEN");
  if (!token) return { status: "skipped", detail: "No GitHub token saved, so the project stays local. Run ./startup.sh and accept the GitHub CLI login to enable this." };
  const base = project.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "meadow-project";
  for (const name of [base, `${base}-meadow`, `${base}-2`, `${base}-3`]) {
    const created = await api<{ clone_url?: string; html_url?: string; full_name?: string; message?: string }>(token, "POST", "/user/repos", { name, private: true, description: (project.description ?? "Built with Meadow").slice(0, 300), auto_init: false });
    if (created.status === 422) continue;
    if (created.status === 401 || created.status === 403) return { status: "skipped", detail: `GitHub refused the saved token (${created.status}${created.data.message ? `: ${created.data.message}` : ""}). It needs the "repo" scope; run gh auth refresh -s repo, then ./startup.sh.` };
    if (created.status !== 201 || !created.data.clone_url || !validClone(created.data.clone_url)) return { status: "skipped", detail: `GitHub did not create the repository (HTTP ${created.status}${created.data.message ? `: ${created.data.message}` : ""}).` };
    await git.git(project.path, "remote", "add", "origin", created.data.clone_url);
    fs.mkdirSync(homePath("github"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker(project.id), JSON.stringify({ cloneUrl: created.data.clone_url, htmlUrl: created.data.html_url ?? created.data.clone_url, fullName: created.data.full_name ?? name }), { mode: 0o600 });
    return { status: "created", detail: `Created the private repository ${created.data.full_name ?? name}.`, url: created.data.html_url };
  }
  return { status: "skipped", detail: `Repositories named ${base} already exist on your account; add a remote yourself or rename the project.` };
}

/** Pushes the base branch to a repository Meadow created. The token goes through git's environment, never the URL or argv. */
export async function pushBase(project: { id: number; path: string; base_branch: string }): Promise<{ pushed: boolean; detail: string }> {
  const repo = meadowCreatedRepo(project.id);
  if (!repo || !loadConfig().services.github.push) return { pushed: false, detail: "" };
  const token = getSecret("GITHUB_TOKEN");
  if (!token) return { pushed: false, detail: "No GitHub token saved; skipped the push." };
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const result = await capture("git", ["push", "--quiet", "origin", `${project.base_branch}:${project.base_branch}`], {
    cwd: project.path,
    timeoutMs: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` },
  });
  return result.code === 0 ? { pushed: true, detail: `Pushed ${project.base_branch} to ${repo.fullName}.` } : { pushed: false, detail: `Push to ${repo.fullName} failed: ${(result.stderr || result.stdout).replace(/AUTHORIZATION:[^\n]*/gi, "").trim().split("\n").slice(-2).join(" ")}` };
}
