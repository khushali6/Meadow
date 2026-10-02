import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getSecret, loadConfig, SECRET_NAMES, type SecretName } from "../config";
import { minimalEnv } from "../core/exec";
import { audit } from "../core/audit";
import { redact, registerSecret } from "../core/redact";

/** External tools are offered to agents only when the server marks them read-only; anything else needs a human. */
export type ExternalTool = { qualified: string; server: string; tool: string; description: string; readOnly: boolean };

const clients = new Map<string, Promise<Client>>();
const CALL_TIMEOUT_MS = 60_000;

function connect(name: string): Promise<Client> {
  const existing = clients.get(name);
  if (existing) return existing;
  const server = loadConfig().atlas.mcpServers.find(entry => entry.name === name);
  if (!server) return Promise.reject(new Error(`No MCP server called ${name} in config.atlas.mcpServers`));
  const env = minimalEnv();
  for (const secretName of server.env) {
    if (!SECRET_NAMES.includes(secretName as SecretName)) continue;
    const value = getSecret(secretName as SecretName);
    if (value) {
      registerSecret(value);
      env[secretName] = value;
    }
  }
  const promise = (async () => {
    const client = new Client({ name: "meadow-atlas", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env, stderr: "ignore" }));
    return client;
  })();
  promise.catch(() => clients.delete(name));
  clients.set(name, promise);
  return promise;
}

export async function listExternalTools(): Promise<ExternalTool[]> {
  const out: ExternalTool[] = [];
  for (const server of loadConfig().atlas.mcpServers) {
    try {
      const client = await connect(server.name);
      const { tools } = await client.listTools();
      for (const tool of tools) out.push({ qualified: `${server.name}__${tool.name}`, server: server.name, tool: tool.name, description: (tool.description ?? "").slice(0, 300), readOnly: tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true });
    } catch {
      // An unreachable server just contributes no tools.
    }
  }
  return out;
}

export async function callExternalTool(qualified: string, args: Record<string, unknown>, ctx: { projectId: number; agent: string }): Promise<string> {
  const started = Date.now();
  const known = (await listExternalTools()).find(tool => tool.qualified === qualified);
  const base = { projectId: ctx.projectId, agent: ctx.agent, user: "local-owner", tool: qualified, args };
  if (!known || !known.readOnly) {
    audit({ ...base, risk: "HIGH_WRITE", approval: "refused", result: "refused", durationMs: 0, detail: known ? "external tool is not read-only" : "unknown external tool" });
    throw new Error(known ? `${qualified} is not marked read-only by its server, so agents can't call it automatically.` : `Unknown external tool ${qualified}`);
  }
  if (!args || typeof args !== "object" || Array.isArray(args) || JSON.stringify(args).length > 20_000) {
    audit({ ...base, risk: "READ", approval: "refused", result: "refused", durationMs: 0, detail: "invalid arguments" });
    throw new Error("External tool arguments must be a JSON object under 20 KB.");
  }
  try {
    const client = await connect(known.server);
    const result = await client.callTool({ name: known.tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
    audit({ ...base, risk: "READ", approval: "not_required", result: result.isError ? "error" : "ok", durationMs: Date.now() - started });
    return redact(text).slice(0, 8000);
  } catch (error) {
    audit({ ...base, risk: "READ", approval: "not_required", result: "error", durationMs: Date.now() - started, detail: (error as Error).message });
    throw error;
  }
}

export async function closeExternalClients() {
  for (const [name, promise] of clients) {
    clients.delete(name);
    await promise.then(client => client.close()).catch(() => undefined);
  }
}
