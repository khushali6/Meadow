import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../core/db";
import { getProject } from "../projects";
import { requestCloudResource } from "../services/cloud";
import { connectedServices } from "../services/registry";
import { askHuman, notifyHuman, requestSystemAction } from "./broker";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ ...text(`Error: ${(error as Error).message}`), isError: true });

/**
 * The "meadow" MCP server the coding engine gets during a run. Every tool is scoped to the one project Meadow
 * started the engine for; nothing here runs a command without the policy table and, where it says so, the user.
 */
export async function startBrokerServer() {
  process.env.MEADOW_ROLE = "mcp";
  console.log = (...args: unknown[]) => console.error(...args);
  getDb();
  const projectId = Number(process.env.MEADOW_BROKER_PROJECT);
  if (!Number.isInteger(projectId) || projectId <= 0) throw new Error("MEADOW_BROKER_PROJECT is not set.");
  const project = getProject(projectId);
  const server = new McpServer({ name: "meadow", version: "1.0.0" }, {
    instructions: `Meadow supervises this run for ${project.name}. Tools: notify_human (status update, milestone, one-way — no reply needed), ask_human (decision you cannot make yourself — waits for answer), request_system_action (anything outside the project: brew, Docker, deploys, pushes), request_cloud_resource (before creating any cloud resource), connected_services (what is available). Never try to work around a refusal.`,
  });

  server.registerTool("notify_human", {
    title: "Notify the user",
    description: "Sends a one-way message to the user on Telegram and the Meadow dashboard. Use for status updates, milestones or non-blocking information. Does NOT wait for a reply — if you need a decision, use ask_human instead.",
    inputSchema: { message: z.string().min(3).max(1500) },
  }, async args => {
    try {
      notifyHuman({ projectId, message: args.message });
      return text("Notification sent.");
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("ask_human", {
    title: "Ask the user",
    description: "Sends a question to the user on Telegram and the Meadow dashboard and waits for the answer. Give 2-6 short options when you can. If nobody answers in time you'll be told to choose the safest option yourself.",
    inputSchema: { question: z.string().min(3).max(300), options: z.array(z.string().min(1).max(60)).max(6).optional(), context: z.string().max(1500).optional() },
  }, async args => {
    try {
      return text(await askHuman({ projectId, ...args }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("request_system_action", {
    title: "Run something outside the project",
    description: "Asks Meadow to run a command your sandbox or rules block: system packages (brew, apt), global tools, Docker, deploys, git push. Meadow checks it against its policy, asks the user when needed, runs it, and returns the output. Forbidden commands (sudo, deleting outside the project, reading secrets) are always refused.",
    inputSchema: { command: z.string().min(1).max(2000), reason: z.string().min(3).max(600) },
  }, async args => {
    try {
      return text(await requestSystemAction({ projectId, ...args }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("request_cloud_resource", {
    title: "Get a cloud resource",
    description: "Call before creating any cloud resource. service: supabase (action create_or_reuse_project; first call list_organizations, list_projects and get_cost with the Supabase tools and pass them as details {organizations, projects, cost}), github (action create_repo), docker (action start). Meadow decides reuse/create/ask, remembers the account choice, and tells you exactly what to do next.",
    inputSchema: { service: z.enum(["supabase", "github", "docker"]).or(z.string().min(1).max(40)), action: z.string().min(1).max(60), details: z.unknown().optional() },
  }, async args => {
    try {
      return text(await requestCloudResource({ projectId, service: args.service, action: args.action, details: args.details }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("connected_services", {
    title: "Connected services",
    description: "Which services (MCP servers like Supabase, GitHub, Docker) are usable right now and what to do when one isn't.",
    inputSchema: {},
  }, async () => {
    try {
      return text(await connectedServices(project.path));
    } catch (error) {
      return failure(error);
    }
  });

  await server.connect(new StdioServerTransport());
}
