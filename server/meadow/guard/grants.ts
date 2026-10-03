import fs from "node:fs";
import { homePath } from "../config";

/** "Always for this project" answers, kept in Meadow's own data folder where the engine can't write. */
const file = (projectId: number) => homePath("grants", `${projectId}.json`);

export function grants(projectId: number): string[] {
  try {
    const value = JSON.parse(fs.readFileSync(file(projectId), "utf8")) as { kinds?: unknown };
    return Array.isArray(value.kinds) ? value.kinds.filter((kind): kind is string => typeof kind === "string") : [];
  } catch {
    return [];
  }
}

export function hasGrant(projectId: number, kind: string): boolean {
  return grants(projectId).includes(kind);
}

export function addGrant(projectId: number, kind: string) {
  if (!/^system\.[a-z-]+$/.test(kind)) throw new Error(`Only system actions can be remembered (got ${kind}).`);
  const kinds = [...new Set([...grants(projectId), kind])];
  fs.mkdirSync(homePath("grants"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(projectId), `${JSON.stringify({ kinds }, null, 2)}\n`, { mode: 0o600 });
}
