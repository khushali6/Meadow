import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getSecret, loadConfig, SECRET_NAMES, type SecretName } from "../config";
import { minimalEnv } from "../core/exec";
import { redact, registerSecret } from "../core/redact";

export type ExternalTool = { qualified: string; server: string; tool: string; description: string };

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
      for (const tool of tools) out.push({ qualified: `${server.name}__${tool.name}`, server: server.name, tool: tool.name, description: (tool.description ?? "").slice(0, 300) });
    } catch {
      // An unreachable server just contributes no tools.
    }
  }
  return out;
}

export async function callExternalTool(qualified: string, args: Record<string, unknown>): Promise<string> {
  const [server, ...rest] = qualified.split("__");
  const client = await connect(server);
  const result = await client.callTool({ name: rest.join("__"), arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
  return redact(text).slice(0, 8000);
}

export async function closeExternalClients() {
  for (const [name, promise] of clients) {
    clients.delete(name);
    await promise.then(client => client.close()).catch(() => undefined);
  }
}
