import fs from "node:fs";
import path from "node:path";
import type { EnvVar, Plan } from "../planning/format";

export const ENV_FILE = ".env.local";
export const ENV_EXAMPLE = ".env.example";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Names defined in a dotenv file, with whether each has a non-empty value. Values themselves are never returned. */
function definedNames(file: string): Map<string, boolean> {
  const names = new Map<string, boolean>();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return names;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(LINE);
    if (!match) continue;
    const value = match[2].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    names.set(match[1], (names.get(match[1]) ?? false) || value.length > 0);
  }
  return names;
}

/** Names that have a value in .env.local or .env. */
export function filledEnvNames(projectPath: string): Set<string> {
  const filled = new Set<string>();
  for (const file of [ENV_FILE, ".env"]) {
    for (const [name, hasValue] of definedNames(path.join(projectPath, file))) if (hasValue) filled.add(name);
  }
  return filled;
}

/** Replaces every value from the project's .env.local / .env found in `text` with [REDACTED]. */
export function scrubProjectEnv(projectPath: string, text: string): string {
  let out = text;
  for (const file of [ENV_FILE, ".env"]) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(projectPath, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const value = line.match(LINE)?.[2].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
      if (value && value.length >= 6) out = out.split(value).join("[REDACTED]");
    }
  }
  return out;
}

/** Gives a git worktree the main checkout's gitignored env files (mode 600) so its app and tests see the same settings. */
export function copyEnvFiles(fromDir: string, toDir: string) {
  for (const file of [ENV_FILE, ".env"]) {
    const source = path.join(fromDir, file);
    const target = path.join(toDir, file);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
  }
}

/** Required variables that are missing or empty. */
export function missingEnv(projectPath: string, plan: Pick<Plan, "env">): EnvVar[] {
  const filled = filledEnvNames(projectPath);
  return plan.env.required.filter(item => !filled.has(item.name));
}

function ensureLines(file: string, header: string, lines: Array<{ name: string; text: string }>, mode?: number): boolean {
  const existing = definedNames(file);
  const add = lines.filter(line => !existing.has(line.name));
  if (!add.length && fs.existsSync(file)) return false;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  const block = [current ? "" : header, ...add.map(line => line.text)].filter(Boolean).join("\n");
  fs.writeFileSync(file, `${current}${prefix}${block}\n`, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
  return true;
}

/**
 * Prepares the project for the plan's environment variables: empty `NAME=` placeholders in .env.local
 * (mode 600, gitignored), the names with hints in .env.example, and .env.local in .gitignore.
 * Returns the tracked files it changed (never .env.local).
 */
export function writeEnvScaffold(projectPath: string, plan: Pick<Plan, "env">): string[] {
  const all = [...plan.env.required, ...plan.env.optional];
  if (!all.length) return [];
  const changed: string[] = [];
  const gitignore = path.join(projectPath, ".gitignore");
  const ignored = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8").split(/\r?\n/).map(line => line.trim()) : [];
  const add: string[] = [];
  if (!ignored.some(line => [ENV_FILE, `/${ENV_FILE}`, ".env*.local", "*.local", ".env*", ".env.*"].includes(line))) add.push(ENV_FILE);
  if (ignored.some(line => [".env*", ".env.*"].includes(line)) && !ignored.includes(`!${ENV_EXAMPLE}`)) add.push(`!${ENV_EXAMPLE}`);
  if (add.length) {
    const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
    fs.writeFileSync(gitignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
    changed.push(".gitignore");
  }
  const comment = (item: EnvVar, optional: boolean) => `${item.hint || optional ? `# ${[item.hint, optional ? "(optional)" : ""].filter(Boolean).join(" ")}\n` : ""}${item.name}=`;
  const entries = [...plan.env.required.map(item => ({ name: item.name, text: comment(item, false) })), ...plan.env.optional.map(item => ({ name: item.name, text: comment(item, true) }))];
  if (ensureLines(path.join(projectPath, ENV_EXAMPLE), "# Copy to .env.local and fill in. Never commit real values.", entries)) changed.push(ENV_EXAMPLE);
  ensureLines(path.join(projectPath, ENV_FILE), "# Local secrets for this project. Gitignored; keep it that way.", entries, 0o600);
  return changed;
}
