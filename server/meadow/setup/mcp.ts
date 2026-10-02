import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig, SECRET_NAMES, type SecretName } from "../config";
import { listExternalTools, type ExternalTool } from "../atlas/mcpClient";

export type DiscoveredMcp = {
  name: string;
  source: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  envNames: string[];
  service: string | null;
  imported: boolean;
  passableSecrets: string[];
  missingSecrets: string[];
};

const SOURCES = [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json"];
const SERVICES: Array<[RegExp, string]> = [[/github/i, "GitHub"], [/gitlab/i, "GitLab"], [/filesystem|server-fs\b/i, "Filesystem"], [/\bgit\b|mcp-server-git/i, "Git"], [/jira|atlassian/i, "Jira"], [/slack/i, "Slack"], [/linear/i, "Linear"], [/postgres/i, "PostgreSQL"], [/sqlite/i, "SQLite"], [/playwright|puppeteer|browser/i, "Browser"], [/sentry/i, "Sentry"], [/notion/i, "Notion"], [/supabase/i, "Supabase"]];
export const KNOWN_SERVICES = ["Filesystem", "Git", "GitHub", "Jira", "Slack", "Linear", "PostgreSQL", "Sentry"];

type RawServer = { command?: string; args?: unknown; env?: Record<string, unknown>; url?: string; type?: string };

/** Lists MCP servers declared in the project's editor configs. Values in `env` are never read, only the variable names. */
export function discoverMcp(root: string): DiscoveredMcp[] {
  const configured = new Set(loadConfig().atlas.mcpServers.map(server => server.name));
  const out: DiscoveredMcp[] = [];
  for (const source of SOURCES) {
    let raw: { mcpServers?: Record<string, RawServer>; servers?: Record<string, RawServer> };
    try {
      raw = JSON.parse(fs.readFileSync(path.join(root, source), "utf8"));
    } catch {
      continue;
    }
    for (const [name, server] of Object.entries(raw.mcpServers ?? raw.servers ?? {})) {
      if (!server || typeof server !== "object" || out.some(item => item.name === name.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40))) continue;
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
      const envNames = Object.keys(server.env ?? {}).filter(key => /^[A-Z][A-Z0-9_]*$/.test(key));
      const haystack = `${name} ${server.command ?? ""} ${args.join(" ")} ${server.url ?? ""}`;
      const safeName = name.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40);
      out.push({
        name: safeName,
        source,
        transport: server.command ? "stdio" : "http",
        command: server.command ?? null,
        args,
        envNames,
        service: SERVICES.find(([pattern]) => pattern.test(haystack))?.[1] ?? null,
        imported: configured.has(safeName),
        passableSecrets: envNames.filter(key => SECRET_NAMES.includes(key as SecretName)),
        missingSecrets: envNames.filter(key => !SECRET_NAMES.includes(key as SecretName)),
      });
    }
  }
  return out;
}

export class McpImportError extends Error {}

/** Adds a discovered stdio server to Meadow. Only secret names Meadow manages are passed through; literal values never are. */
export function importMcp(root: string, name: string) {
  const found = discoverMcp(root).find(item => item.name === name);
  if (!found) throw new McpImportError(`No MCP server called ${name} in this project's configs.`);
  if (found.transport !== "stdio" || !found.command) throw new McpImportError(`${name} uses HTTP transport, which Meadow doesn't connect to yet. Only local (stdio) servers are supported.`);
  const servers = loadConfig().atlas.mcpServers.filter(server => server.name !== found.name);
  servers.push({ name: found.name, command: found.command, args: found.args, env: found.passableSecrets });
  saveConfig({ atlas: { mcpServers: servers } });
  return found;
}

export function removeMcp(name: string) {
  saveConfig({ atlas: { mcpServers: loadConfig().atlas.mcpServers.filter(server => server.name !== name) } });
}

export type McpCapabilities = { server: string; reachable: boolean; error: string | null; tools: Array<Pick<ExternalTool, "tool" | "description" | "risk">>; policy: Record<ExternalTool["risk"], string> };

export const EXTERNAL_POLICY: McpCapabilities["policy"] = { READ: "Runs automatically", WRITE: "Needs your approval", DESTRUCTIVE: "Always needs approval; never from MCP clients" };

export async function mcpCapabilities(name: string): Promise<McpCapabilities> {
  if (!loadConfig().atlas.mcpServers.some(server => server.name === name)) return { server: name, reachable: false, error: "Not added to Meadow", tools: [], policy: EXTERNAL_POLICY };
  const tools = await listExternalTools(name);
  return { server: name, reachable: tools.length > 0, error: tools.length ? null : "The server didn't start or exposes no tools", tools: tools.map(tool => ({ tool: tool.tool, description: tool.description, risk: tool.risk })), policy: EXTERNAL_POLICY };
}
