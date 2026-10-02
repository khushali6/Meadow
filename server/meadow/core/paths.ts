import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Turns a user-typed folder (`~/code/app`, `"C:\My Code"`, `/srv/app/`) into an absolute path, or null when it is relative. */
export function userPath(input: string): string | null {
  let value = input.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (value === "~" || /^~[\\/]/.test(value)) value = path.join(os.homedir(), value.slice(1));
  return path.isAbsolute(value) ? path.resolve(value) : null;
}

export class PathEscapeError extends Error {}

function realpathLoose(target: string): string {
  // Resolve the longest existing prefix, so not-yet-created files are still checked against symlinks.
  let current = path.resolve(target);
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  const real = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return path.join(real, ...rest);
}

export function isInside(root: string, target: string): boolean {
  const realRoot = realpathLoose(root);
  const realTarget = realpathLoose(path.isAbsolute(target) ? target : path.join(root, target));
  const rel = path.relative(realRoot, realTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve `relative` inside `root`, throwing if it escapes via `..`, absolute paths or symlinks. */
export function confine(root: string, relative: string): string {
  if (relative.includes("\0")) throw new PathEscapeError("Path contains a null byte");
  const candidate = path.isAbsolute(relative) ? relative : path.join(root, relative);
  if (!isInside(root, candidate)) throw new PathEscapeError(`Path escapes the project root: ${relative}`);
  return path.resolve(candidate);
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export function validProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(name);
}
