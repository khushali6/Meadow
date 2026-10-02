import fs from "node:fs";
import path from "node:path";
import { currentBranch, git } from "../core/git";
import { listProjectFiles } from "../rag/index";

export type ProjectContext = { stack: string[]; files: string[]; branch: string | null; recentCommits: string[]; spec: string | null; plan: string | null };

export function detectStack(root: string): string[] {
  const stack = new Set<string>();
  const read = (file: string) => {
    try {
      return fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      return null;
    }
  };
  const pkg = read("package.json");
  if (pkg) {
    try {
      const data = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...data.dependencies, ...data.devDependencies };
      stack.add("node");
      for (const [dep, label] of [["next", "nextjs"], ["react", "react"], ["vue", "vue"], ["svelte", "svelte"], ["astro", "astro"], ["express", "express"], ["fastify", "fastify"], ["vite", "vite"], ["typescript", "typescript"], ["tailwindcss", "tailwind"], ["prisma", "prisma"], ["vitest", "vitest"], ["jest", "jest"]] as const) {
        if (deps[dep]) stack.add(label);
      }
    } catch {
      stack.add("node");
    }
  }
  const pyproject = read("pyproject.toml") ?? read("requirements.txt");
  if (pyproject) {
    stack.add("python");
    for (const [dep, label] of [["fastapi", "fastapi"], ["django", "django"], ["flask", "flask"], ["pytest", "pytest"]] as const) if (pyproject.toLowerCase().includes(dep)) stack.add(label);
  }
  if (read("Cargo.toml")) stack.add("rust");
  if (read("go.mod")) stack.add("go");
  return Array.from(stack);
}

export async function gatherContext(root: string): Promise<ProjectContext> {
  const read = (file: string) => {
    try {
      return fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      return null;
    }
  };
  let branch: string | null = null;
  let recentCommits: string[] = [];
  try {
    branch = await currentBranch(root);
    recentCommits = (await git(root, "log", "--oneline", "-n", "8")).trim().split("\n").filter(Boolean);
  } catch {
    // Not a git repo yet.
  }
  return { stack: detectStack(root), files: listProjectFiles(root).slice(0, 200), branch, recentCommits, spec: read("SPEC.md"), plan: read("PLAN.md") };
}

export function contextSummary(context: ProjectContext): string {
  return [
    `Detected stack: ${context.stack.join(", ") || "none (empty project)"}`,
    context.branch ? `Git branch: ${context.branch}` : "",
    context.recentCommits.length ? `Recent commits:\n${context.recentCommits.join("\n")}` : "",
    context.files.length ? `Files (${context.files.length}):\n${context.files.slice(0, 80).join("\n")}` : "No files yet.",
    context.spec ? `Current SPEC.md:\n${context.spec.slice(0, 3000)}` : "",
  ].filter(Boolean).join("\n\n");
}
