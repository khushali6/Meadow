import fs from "node:fs";
import path from "node:path";
import { isInside } from "./paths";

function readName(dir: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name ?? null;
  } catch {
    return null;
  }
}

/** A checkout of Meadow's own source, recognised by its package name and harness folder. */
export function isMeadowSource(dir: string): boolean {
  return readName(dir) === "meadow" && fs.existsSync(path.join(dir, "server", "meadow", "harness"));
}

/** The folder Meadow is running from (the package root above dist/cli.js), or null when it can't be found. */
export function meadowInstallRoot(entry = process.argv[1]): string | null {
  if (!entry) return null;
  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(entry));
  } catch {
    return null;
  }
  for (let i = 0; i < 4; i++) {
    if (readName(dir) === "meadow") return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Returns the Meadow folder a project path would touch (the path is Meadow, sits inside it, or contains it), else null.
 * Coding agents get write access to the whole project, so pointing one at Meadow lets it rewrite Meadow itself.
 */
export function overlapsMeadow(projectPath: string): string | null {
  const target = path.resolve(projectPath);
  const roots = new Set<string>();
  const install = meadowInstallRoot();
  if (install) roots.add(install);
  for (let dir = target, i = 0; i < 8; i++) {
    if (isMeadowSource(dir)) roots.add(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const root of roots) if (isInside(root, target) || isInside(target, root)) return root;
  return null;
}

export function meadowOverlapMessage(projectPath: string, root: string): string {
  return path.resolve(projectPath) === path.resolve(root)
    ? `${root} is Meadow's own folder. Pick a separate folder for your project so the coding agent can't edit Meadow itself.`
    : `${path.resolve(projectPath)} overlaps Meadow's own folder (${root}). Pick a folder outside it so the coding agent can't edit Meadow itself.`;
}
