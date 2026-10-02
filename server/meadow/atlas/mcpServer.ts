import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../core/db";
import { createProject, findProject, getProject, listProjects, type ProjectRow } from "../projects";
import { ingestProject } from "./ingest";
import { graphStats } from "./store";
import { runTool, TOOLS } from "./tools";

function resolveProject(name: string | undefined, fallback: string | undefined): ProjectRow {
  const wanted = name || fallback || process.env.MEADOW_PROJECT;
  if (wanted) return getProject(wanted);
  const cwd = fs.realpathSync(process.cwd());
  const byPath = listProjects().filter(project => cwd === project.path || cwd.startsWith(`${project.path}${path.sep}`)).sort((a, b) => b.path.length - a.path.length)[0];
  if (byPath) return byPath;
  const all = listProjects();
  if (all.length === 1) return all[0];
  throw new Error(`Pass "project". Known projects: ${all.map(project => project.name).join(", ") || "none (call index_project first)"}`);
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ ...text(`Error: ${(error as Error).message}`), isError: true });

/** stdio MCP server for Cursor, Claude Code and other MCP clients. Nothing but protocol traffic may go to stdout. */
export async function startMcpServer(options: { project?: string } = {}) {
  process.env.MEADOW_ROLE = "mcp";
  console.log = (...args: unknown[]) => console.error(...args);
  getDb();
  const server = new McpServer({ name: "meadow-codeatlas", version: "1.0.0" }, { instructions: "CodeAtlas answers questions about this codebase from a local knowledge graph (code, services, APIs, tables, git history, releases, PRs, incidents). Prefer `investigate` for why/how questions, `search_code` for lookups. Write actions (create_issue, run_tests, propose_patch) wait for the owner's approval in Meadow." });

  server.registerTool("list_projects", { title: "List projects", description: "Projects known to Meadow with their index status.", inputSchema: {} }, async () => {
    try {
      return text(listProjects().map(project => ({ name: project.name, path: project.path, indexed: graphStats(project.id).lastIngest?.at ?? null })));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("index_project", {
    title: "Index a repository",
    description: "Registers an existing git repository with Meadow (adds a .meadow/ folder) and builds its knowledge graph. Re-run to refresh after changes.",
    inputSchema: { path: z.string().optional().describe("Absolute path to a git repository; defaults to the server's working directory"), name: z.string().optional() },
  }, async args => {
    try {
      const target = fs.realpathSync(args.path ?? process.cwd());
      if (!fs.existsSync(path.join(target, ".git"))) throw new Error(`${target} is not a git repository`);
      const existing = listProjects().find(project => project.path === target) ?? (args.name ? findProject(args.name) : undefined);
      const project = existing ?? (await createProject({ name: args.name ?? path.basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, "-"), path: target }));
      const stats = await ingestProject(project.id);
      return text({ project: project.name, ...stats });
    } catch (error) {
      return failure(error);
    }
  });

  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: `${tool.description}${tool.risk === "read" ? "" : " Requires owner approval in Meadow."}`,
      inputSchema: { project: z.string().optional().describe("Meadow project name; defaults to the project containing the working directory"), ...tool.shape },
      annotations: { readOnlyHint: tool.risk === "read", destructiveHint: tool.risk !== "read", openWorldHint: false },
    }, async (args: Record<string, unknown>) => {
      try {
        const { project, ...rest } = args;
        const row = resolveProject(project as string | undefined, options.project);
        if (!graphStats(row.id).lastIngest) await ingestProject(row.id);
        const result = await runTool(tool.name, rest, { projectId: row.id, actor: "mcp" });
        return text({ summary: result.summary, ...(result.pending ? { pending: result.pending } : {}), data: result.data });
      } catch (error) {
        return failure(error);
      }
    });
  }

  await server.connect(new StdioServerTransport());
  return server;
}

export function mcpConfigSnippet(cliPath: string) {
  const tsx = path.resolve(path.dirname(cliPath), "..", "node_modules", ".bin", "tsx");
  const [command, args] = cliPath.endsWith(".ts") ? [tsx, [cliPath, "mcp"]] : [process.execPath, [cliPath, "mcp"]];
  const entry = { command, args, ...(process.env.MEADOW_HOME ? { env: { MEADOW_HOME: process.env.MEADOW_HOME } } : {}) };
  return {
    cursor: { file: ".cursor/mcp.json in the repo, or ~/.cursor/mcp.json for every project", json: { mcpServers: { meadow: entry } } },
    claudeCode: { command: `claude mcp add meadow${process.env.MEADOW_HOME ? ` -e MEADOW_HOME=${process.env.MEADOW_HOME}` : ""} -- ${command} ${args.join(" ")}` },
  };
}
