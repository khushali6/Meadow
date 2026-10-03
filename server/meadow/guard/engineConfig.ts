import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, meadowHome } from "../config";
import { capture } from "../core/exec";
import { meadowInstallRoot } from "../core/self";
import { cliPermissions } from "./policy";

export const CLI_CONFIG = path.join(".cursor", "cli.json");
export const MCP_CONFIG = path.join(".cursor", "mcp.json");

/** How the engine starts Meadow's broker: the same Meadow build that is running now. */
export function brokerEntry(projectId: number): { command: string; args: string[]; env: Record<string, string> } | null {
  const root = meadowInstallRoot() ?? meadowInstallRoot(fileURLToPath(import.meta.url));
  if (!root) return null;
  const built = path.join(root, "dist", "meadow.js");
  const source = path.join(root, "server", "cli.ts");
  const tsx = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const env = { MEADOW_HOME: meadowHome(), MEADOW_BROKER_PROJECT: String(projectId) };
  if (fs.existsSync(built)) return { command: process.execPath, args: [built, "broker"], env };
  if (fs.existsSync(source) && fs.existsSync(tsx)) return { command: tsx, args: [source, "broker"], env };
  return null;
}

const tracked = async (cwd: string, file: string) => (await capture("git", ["ls-files", "--error-unmatch", file], { cwd })).code === 0;

/** Keeps Meadow's machine-specific engine files out of the user's commits (they contain local paths). */
function excludeLocally(cwd: string, files: string[]) {
  const exclude = path.join(cwd, ".git", "info", "exclude");
  if (!fs.existsSync(path.dirname(exclude))) return;
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  const missing = files.map(file => `/${file.split(path.sep).join("/")}`).filter(line => !current.split("\n").includes(line));
  if (missing.length) fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}# Meadow engine guardrails (local only)\n${missing.join("\n")}\n`);
}

function expectedMcp(cwd: string, projectId: number): Record<string, unknown> | null {
  const entry = brokerEntry(projectId);
  if (!entry) return null;
  let existing: { mcpServers?: Record<string, unknown> } = {};
  try {
    existing = JSON.parse(fs.readFileSync(path.join(cwd, MCP_CONFIG), "utf8"));
  } catch {
    // None yet, or unreadable: Meadow writes a fresh one.
  }
  return { ...existing, mcpServers: { ...(existing.mcpServers ?? {}), meadow: entry } };
}

export type GuardFiles = { brokerAvailable: boolean; notes: string[] };

/** Writes `.cursor/cli.json` (permissions) and registers Meadow's broker in `.cursor/mcp.json` before each engine run. */
export async function writeEngineGuards(cwd: string, projectId: number): Promise<GuardFiles> {
  const notes: string[] = [];
  fs.mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
  const local: string[] = [];
  if (await tracked(cwd, CLI_CONFIG)) notes.push(".cursor/cli.json is part of this repository, so Meadow relies on its after-run command checks instead of writing engine permissions.");
  else {
    fs.writeFileSync(path.join(cwd, CLI_CONFIG), `${JSON.stringify(cliPermissions(), null, 2)}\n`);
    local.push(CLI_CONFIG);
  }
  let brokerAvailable = false;
  const mcp = loadConfig().guard.broker ? expectedMcp(cwd, projectId) : undefined;
  if (mcp === undefined) {
    // The user turned the broker off in Settings.
  } else if (!mcp) notes.push("Meadow's broker could not be located, so the engine can't ask you questions or request installs this run.");
  else if (await tracked(cwd, MCP_CONFIG)) notes.push(".cursor/mcp.json is part of this repository, so Meadow did not add its broker to it.");
  else {
    fs.writeFileSync(path.join(cwd, MCP_CONFIG), `${JSON.stringify(mcp, null, 2)}\n`);
    local.push(MCP_CONFIG);
    brokerAvailable = true;
  }
  excludeLocally(cwd, local);
  return { brokerAvailable, notes };
}

/** After a run: the engine must not loosen its own rules. Restores the files and reports what changed. */
export async function checkEngineGuards(cwd: string, projectId: number): Promise<string | null> {
  const problems: string[] = [];
  const read = (file: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8"));
    } catch {
      return null;
    }
  };
  if (!(await tracked(cwd, CLI_CONFIG)) && JSON.stringify(read(CLI_CONFIG)) !== JSON.stringify(cliPermissions())) problems.push(CLI_CONFIG);
  const mcp = read(MCP_CONFIG) as { mcpServers?: Record<string, unknown> } | null;
  const entry = loadConfig().guard.broker ? brokerEntry(projectId) : null;
  if (entry && !(await tracked(cwd, MCP_CONFIG)) && JSON.stringify(mcp?.mcpServers?.meadow) !== JSON.stringify(entry)) problems.push(MCP_CONFIG);
  if (!problems.length) return null;
  await writeEngineGuards(cwd, projectId);
  return `You changed Meadow's guardrail files (${problems.join(", ")}); they were restored. Never edit .cursor/cli.json or Meadow's entry in .cursor/mcp.json.`;
}
