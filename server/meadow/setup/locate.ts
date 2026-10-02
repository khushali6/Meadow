import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../config";
import { capture, networkEnv, which } from "../core/exec";
import { userPath } from "../core/paths";
import { isWsl } from "../doctor";
import { listProjects } from "../projects";
import { detectProject, profileLines } from "./detect";

export type RepoMatch = { path: string; name: string; exact: boolean; git: boolean; branch: string | null; remote: string | null; modifiedAt: string; lines: string[]; registered: boolean };
export type CloneTarget = { url: string; slug: string; target: string; via: "gh" | "git"; exists: boolean };
export type LocateResult = {
  query: string;
  kind: "path" | "name" | "remote";
  matches: RepoMatch[];
  clone: CloneTarget | null;
  create: { target: string; exists: boolean } | null;
  placeDir: string;
  placeReason: string;
  searched: number;
};

const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "Gemfile", "composer.json", "setup.py", "build.gradle.kts", "deno.json"];
const SKIP = new Set(["node_modules", "Library", "Applications", "AppData", "Application Data", "Music", "Movies", "Pictures", "Photos", "Videos", "Downloads", "vendor", "dist", "build", "target", "venv", "__pycache__", "Program Files", "Program Files (x86)", "Windows", "$Recycle.Bin", "System Volume Information", "snap", "go", "miniconda3", "anaconda3"]);
const CODE_FOLDERS = ["code", "Code", "projects", "Projects", "dev", "Dev", "Developer", "src", "repos", "Repos", "workspace", "Workspace", "workspaces", "work", "git", "github", "GitHub", "Sites", "source/repos", path.join("Documents", "GitHub"), path.join("Documents", "Projects"), path.join("Documents", "code"), "Documents", "Desktop", path.join("OneDrive", "Documents")];

const normalise = (value: string) => value.toLowerCase().replace(/\.git$/, "").replace(/[^a-z0-9]/g, "");
const isProject = (dir: string) => fs.existsSync(path.join(dir, ".git")) || MANIFESTS.some(file => fs.existsSync(path.join(dir, file)));
const exists = (dir: string) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** Where developers keep code on this platform, in the order we look. */
export function searchRoots(): Array<{ dir: string; depth: number; self?: boolean }> {
  const home = os.homedir();
  const roots: Array<{ dir: string; depth: number; self?: boolean }> = [];
  const add = (raw: string, depth: number, self = false) => {
    if (!raw || !exists(raw)) return;
    const dir = fs.realpathSync(raw);
    if (!roots.some(root => root.dir === dir)) roots.push({ dir, depth, self });
  };
  add(loadConfig().projectsDir, 2);
  add(process.cwd(), 2, true);
  add(path.dirname(process.cwd()), 1);
  for (const folder of CODE_FOLDERS) add(path.join(home, folder), folder === "Documents" || folder === "Desktop" ? 2 : 3);
  if (process.platform === "win32") for (const drive of ["C:", "D:"]) for (const folder of ["dev", "src", "code", "projects", "repos", "git"]) add(`${drive}\\${folder}`, 3);
  if (isWsl()) {
    const user = process.env.USER ?? "";
    for (const winHome of [`/mnt/c/Users/${user}`, ...safeList("/mnt/c/Users").map(name => `/mnt/c/Users/${name}`)]) for (const folder of ["source/repos", "code", "projects", "Documents/GitHub"]) add(path.join(winHome, folder), 2);
  }
  add(home, 1);
  return roots;
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Walks the code folders breadth-first with a time and size budget; never descends into a project once found. */
function scan(query: string, budget = { dirs: 8000, ms: 2500 }) {
  const wanted = normalise(query);
  const started = Date.now();
  const seen = new Set<string>();
  const found: Array<{ dir: string; exact: boolean }> = [];
  const reposPerParent = new Map<string, number>();
  for (const root of searchRoots()) {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root.dir, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift()!;
      if (seen.has(dir) || seen.size > budget.dirs || Date.now() - started > budget.ms) continue;
      seen.add(dir);
      const project = (depth > 0 || root.self) && isProject(dir);
      if (project) {
        reposPerParent.set(path.dirname(dir), (reposPerParent.get(path.dirname(dir)) ?? 0) + 1);
        const name = normalise(path.basename(dir));
        if (wanted && (name === wanted || (wanted.length >= 3 && name.includes(wanted)))) found.push({ dir, exact: name === wanted });
        continue;
      }
      if (depth >= root.depth) continue;
      for (const entry of safeEntries(dir)) if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name)) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return { found, reposPerParent, searched: seen.size };
}

function safeEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Where a new or cloned repository goes: MEADOW_PROJECTS_DIR or a projects folder the user chose, else the folder
 * that already holds most of their repositories, else the platform convention.
 */
export function placementFor(reposPerParent: Map<string, number>): { dir: string; reason: string } {
  const home = os.homedir();
  const config = loadConfig();
  if (process.env.MEADOW_PROJECTS_DIR) return { dir: config.projectsDir, reason: "MEADOW_PROJECTS_DIR is set" };
  if (config.projectsDir !== DEFAULT_CONFIG.projectsDir) return { dir: config.projectsDir, reason: "your projects folder in settings" };
  const busiest = [...reposPerParent.entries()].filter(([dir, count]) => count >= 2 && dir !== home && !dir.startsWith(os.tmpdir())).sort((a, b) => b[1] - a[1])[0];
  if (busiest) return { dir: busiest[0], reason: `${busiest[1]} of your other repositories are there` };
  const convention = process.platform === "win32" ? [path.join(home, "source", "repos"), path.join(home, "code")] : process.platform === "darwin" ? [path.join(home, "Developer"), path.join(home, "code")] : [path.join(home, "code"), path.join(home, "projects")];
  const dir = convention.find(exists) ?? convention[convention.length - 1];
  return { dir, reason: process.platform === "win32" ? "the usual place for code on Windows" : process.platform === "darwin" ? "the usual place for code on macOS" : "the usual place for code on Linux" };
}

/** Parses `owner/repo`, an HTTPS or SSH git URL. Anything with options, spaces or odd schemes is rejected. */
export function parseRemote(query: string): { url: string; slug: string; github: boolean } | null {
  const value = query.trim();
  if (!value || value.startsWith("-") || /\s/.test(value)) return null;
  const short = value.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/);
  if (short && !short[2].startsWith(".")) return { url: `https://github.com/${short[1]}/${short[2].replace(/\.git$/, "")}.git`, slug: short[2].replace(/\.git$/, ""), github: true };
  const https = value.match(/^https:\/\/([A-Za-z0-9.-]+)(?::\d+)?\/([A-Za-z0-9._~\/-]+?)(?:\.git)?\/?$/);
  if (https && !value.includes("@")) return { url: `https://${https[1]}/${https[2]}.git`, slug: https[2].split("/").pop()!, github: https[1] === "github.com" };
  const ssh = value.match(/^git@([A-Za-z0-9.-]+):([A-Za-z0-9._~\/-]+?)(?:\.git)?$/);
  if (ssh) return { url: value, slug: ssh[2].split("/").pop()!, github: ssh[1] === "github.com" };
  return null;
}

const matchOf = (dir: string, exact: boolean): RepoMatch => {
  const profile = detectProject(dir);
  let modifiedAt = new Date(0).toISOString();
  try {
    modifiedAt = fs.statSync(dir).mtime.toISOString();
  } catch {
    /* unreadable */
  }
  const registered = listProjects().some(project => path.resolve(project.path) === path.resolve(dir));
  return { path: dir, name: path.basename(dir), exact, git: profile.git.repo, branch: profile.git.branch, remote: profile.git.remote, modifiedAt, lines: profileLines(profile), registered };
};

/** Turns whatever the user typed (a name, a path, `owner/repo`, a git URL) into concrete options. */
export async function locateRepository(query: string): Promise<LocateResult> {
  const value = query.trim();
  const remote = parseRemote(value);
  const direct = !remote || /^[~/\\]|^[a-zA-Z]:/.test(value) ? userPath(value) : null;
  const name = remote?.slug ?? (direct ? path.basename(direct) : value);
  const { found, reposPerParent, searched } = scan(direct ? "" : name);
  const place = placementFor(reposPerParent);

  if (direct) {
    const isDir = exists(direct);
    return { query: value, kind: "path", matches: isDir ? [matchOf(direct, true)] : [], clone: null, create: isDir ? null : { target: direct, exists: false }, placeDir: path.dirname(direct), placeReason: "the path you typed", searched };
  }

  for (const project of listProjects()) if (normalise(project.name) === normalise(name) && exists(project.path) && !found.some(item => path.resolve(item.dir) === path.resolve(project.path))) found.push({ dir: project.path, exact: true });
  const matches = found.map(item => matchOf(item.dir, item.exact)).sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.registered) - Number(a.registered) || b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 8);
  const safeName = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80) || "project";
  const target = path.join(place.dir, safeName);
  const clone = remote ? { url: remote.url, slug: remote.slug, target, via: remote.github && (await which("gh")) ? ("gh" as const) : ("git" as const), exists: exists(target) } : null;
  return { query: value, kind: remote ? "remote" : "name", matches, clone, create: remote || matches.some(match => match.exact) ? null : { target, exists: exists(target) }, placeDir: place.dir, placeReason: place.reason, searched };
}

export class LocateError extends Error {}

/** Clones into the chosen folder. Never prompts for a password (it would hang the daemon); private repos need gh or SSH auth. */
export async function cloneRepository(url: string, target: string, onProgress: (detail: string) => void = () => undefined): Promise<string> {
  const remote = parseRemote(url);
  if (!remote) throw new LocateError("That isn't a repository Meadow can clone (use owner/repo, an https:// URL or git@host:owner/repo).");
  const resolved = path.resolve(target);
  if (exists(resolved) && safeList(resolved).length) {
    const existing = detectProject(resolved).git.remote?.replace(/\.git$/, "");
    if (existing && remote.url.replace(/\.git$/, "").endsWith(existing.split(/[/:]/).slice(-2).join("/"))) return resolved;
    throw new LocateError(`${resolved} already exists and isn't empty. Pick another name or remove it.`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const env = networkEnv({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
  const owner = remote.github ? remote.url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] : null;
  const viaGh = owner && (await which("gh"));
  onProgress(`Cloning ${owner ?? remote.url} into ${resolved}`);
  const result = viaGh ? await capture("gh", ["repo", "clone", owner!, resolved, "--", "--quiet"], { env, timeoutMs: 15 * 60_000 }) : await capture("git", ["clone", "--quiet", "--", remote.url, resolved], { env, timeoutMs: 15 * 60_000 });
  if (result.code !== 0) {
    fs.rmSync(resolved, { recursive: true, force: true });
    const text = `${result.stderr}\n${result.stdout}`;
    if (/could not read Username|Authentication failed|terminal prompts disabled|Repository not found|not found|403/i.test(text)) throw new LocateError(`Couldn't clone ${owner ?? remote.url}: it doesn't exist or it's private. For private repositories run \`gh auth login\` once (or use the SSH URL with your SSH key), then try again.`);
    if (/Could not resolve host|unable to access|timed out/i.test(text)) throw new LocateError(`Couldn't reach the git host. Check your network or proxy (HTTPS_PROXY), then try again.`);
    throw new LocateError(`git clone failed: ${text.trim().split("\n").slice(-3).join(" ")}`);
  }
  return resolved;
}

/** Creates an empty project folder (git is initialised when it is registered). */
export function createProjectFolder(target: string): string {
  const resolved = path.resolve(target);
  if (exists(resolved) && safeList(resolved).length) throw new LocateError(`${resolved} already exists and isn't empty.`);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}
