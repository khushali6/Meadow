import fs from "node:fs";
import path from "node:path";
import { capture } from "./exec";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Meadow",
  GIT_AUTHOR_EMAIL: "meadow@localhost",
  GIT_COMMITTER_NAME: "Meadow",
  GIT_COMMITTER_EMAIL: "meadow@localhost",
  GIT_TERMINAL_PROMPT: "0",
};

export class GitError extends Error {}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const result = await capture("git", args, { cwd, env: GIT_ENV, timeoutMs: 60_000 });
    if (result.code === 0) return result.stdout;
    const output = (result.stderr || result.stdout).trim();
    // A background `git status` (indexing, editors) briefly holds index.lock; wait it out instead of failing the phase.
    if (attempt < 20 && /index\.lock': File exists/.test(output)) {
      await new Promise(resolve => setTimeout(resolve, 150));
      continue;
    }
    throw new GitError(`git ${args.join(" ")} failed: ${output}`);
  }
}

export const DEFAULT_GITIGNORE = ["node_modules/", ".env", ".env.*", "!.env.example", "*.pem", "*.key", "dist/", "build/", ".next/", "__pycache__/", ".venv/", ".meadow/screenshots/", ".meadow/logs/", ".DS_Store", ""].join("\n");

export async function ensureRepo(cwd: string, baseBranch = "main") {
  fs.mkdirSync(cwd, { recursive: true });
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    const init = await capture("git", ["init", "-q", "-b", baseBranch], { cwd, env: GIT_ENV });
    if (init.code !== 0) {
      // git before 2.28 has no -b.
      await git(cwd, "init", "-q");
      await git(cwd, "symbolic-ref", "HEAD", `refs/heads/${baseBranch}`);
    }
  }
  const gitignore = path.join(cwd, ".gitignore");
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, DEFAULT_GITIGNORE);
  const hasCommit = await capture("git", ["rev-parse", "--verify", "HEAD"], { cwd, env: GIT_ENV });
  if (hasCommit.code !== 0) {
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-q", "--allow-empty", "-m", "meadow: initialise project");
  }
}

export async function currentBranch(cwd: string) {
  return (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).trim();
}

export async function headSha(cwd: string) {
  return (await git(cwd, "rev-parse", "HEAD")).trim();
}

export async function branchExists(cwd: string, branch: string) {
  const result = await capture("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd, env: GIT_ENV });
  return result.code === 0;
}

export type StatusEntry = { code: string; path: string; origPath?: string };

export async function status(cwd: string): Promise<StatusEntry[]> {
  const out = await git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const parts = out.split("\0").filter(Boolean);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const file = parts[i].slice(3);
    if (code.startsWith("R") || code.startsWith("C")) {
      entries.push({ code, path: file, origPath: parts[i + 1] });
      i += 1;
    } else {
      entries.push({ code, path: file });
    }
  }
  return entries;
}

export async function isClean(cwd: string) {
  return (await status(cwd)).length === 0;
}

export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await git(cwd, "add", "-A");
  if ((await git(cwd, "diff", "--cached", "--name-only")).trim() === "") return null;
  await git(cwd, "commit", "-q", "-m", message);
  return headSha(cwd);
}

export async function checkoutNewBranch(cwd: string, branch: string, from?: string) {
  if (await branchExists(cwd, branch)) {
    await git(cwd, "checkout", "-q", branch);
    if (from) await git(cwd, "reset", "-q", "--hard", from);
  } else {
    await git(cwd, "checkout", "-q", "-b", branch, ...(from ? [from] : []));
  }
}

export async function checkout(cwd: string, ref: string) {
  await git(cwd, "checkout", "-q", ref);
}

export async function fastForward(cwd: string, base: string, branch: string) {
  await git(cwd, "checkout", "-q", base);
  await git(cwd, "merge", "-q", "--ff-only", branch);
}

export type DiffFile = { path: string; additions: number; deletions: number; kind: "added" | "modified" | "deleted" | "renamed" };

/** Diff between `from` and the working tree, untracked files included. */
export async function diffStat(cwd: string, from: string): Promise<DiffFile[]> {
  await git(cwd, "add", "-A", "--intent-to-add");
  const numstat = await git(cwd, "diff", "--numstat", from);
  const names = await git(cwd, "diff", "--name-status", from);
  const kinds = new Map<string, DiffFile["kind"]>();
  for (const line of names.split("\n").filter(Boolean)) {
    const [code, ...rest] = line.split("\t");
    const file = rest[rest.length - 1];
    kinds.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified");
  }
  return numstat.split("\n").filter(Boolean).map(line => {
    const [add, del, file] = line.split("\t");
    return { path: file, additions: Number(add) || 0, deletions: Number(del) || 0, kind: kinds.get(file) ?? "modified" };
  });
}

export async function diffText(cwd: string, from: string, maxChars = 200_000): Promise<string> {
  await git(cwd, "add", "-A", "--intent-to-add");
  const out = await git(cwd, "diff", "--no-color", from);
  return out.length > maxChars ? out.slice(0, maxChars) + "\n… diff truncated" : out;
}

export async function revertPaths(cwd: string, base: string, paths: string[]) {
  for (const file of paths) {
    const tracked = await capture("git", ["cat-file", "-e", `${base}:${file}`], { cwd, env: GIT_ENV });
    if (tracked.code === 0) {
      await git(cwd, "checkout", "-q", base, "--", file);
    } else {
      await capture("git", ["rm", "-q", "--cached", "--force", "--", file], { cwd, env: GIT_ENV });
      fs.rmSync(path.join(cwd, file), { force: true, recursive: true });
    }
  }
}

export async function resetHard(cwd: string, ref: string) {
  await git(cwd, "reset", "-q", "--hard", ref);
  await git(cwd, "clean", "-fdq", "-e", ".meadow/");
}

/** Keep the failed branch for inspection under failed/, then return to the base branch tip. */
export async function preserveAndReset(cwd: string, failedBranch: string, base: string) {
  const branch = await currentBranch(cwd);
  if (branch === failedBranch) {
    await commitAll(cwd, `meadow: preserve failed attempt on ${failedBranch}`);
  }
  if (await branchExists(cwd, failedBranch)) {
    const target = `failed/${failedBranch.replace(/^meadow\//, "")}-${Date.now()}`;
    await git(cwd, "branch", "-m", failedBranch, target);
  }
  await git(cwd, "checkout", "-q", "-f", base);
  await resetHard(cwd, base);
}
