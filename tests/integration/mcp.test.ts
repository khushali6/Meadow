import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(__dirname, "../..");
const cli = ["--import", pathToFileURL(path.join(repo, "node_modules", "tsx", "dist", "loader.mjs")).href, path.join(repo, "server", "cli.ts")];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-mcp-"));
const env = { ...process.env, MEADOW_HOME: path.join(root, "home"), MEADOW_PROJECTS_DIR: path.join(root, "projects"), MEADOW_NO_JSONL: "1", FREELLMAPI_API_KEY: "" } as Record<string, string>;
let client: Client;

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  return { isError: Boolean(result.isError), text, json: result.isError ? null : JSON.parse(text) };
};

beforeAll(async () => {
  execFileSync(process.execPath, [...cli, "atlas", "demo"], { env, stdio: "ignore" });
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [...cli, "mcp"], cwd: path.join(root, "projects", "acmepay"), env, stderr: "ignore" }));
}, 60_000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("meadow mcp", () => {
  it("lists every CodeAtlas tool with schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    for (const name of ["search_code", "get_repository_map", "find_dependencies", "trace_service", "find_related_incidents", "get_recent_deployments", "get_pull_request", "get_issue", "query_architecture", "get_owner", "run_tests", "create_issue", "propose_patch", "investigate", "index_project"]) expect(names).toContain(name);
    const search = tools.find(tool => tool.name === "search_code")!;
    expect(search.inputSchema.required).toContain("query");
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(tool => tool.name === "propose_patch")!.annotations?.readOnlyHint).toBe(false);
  });

  it("resolves the project from the working directory and answers", async () => {
    const deps = await call("find_dependencies", { entity: "payment-service", direction: "in" });
    expect(deps.json.data.dependents.map((d: { name: string }) => d.name).sort()).toEqual(["api-gateway", "order-service"]);
    const answer = await call("investigate", { question: "Why did payment API timeouts start after release v2.4.0?" });
    expect(answer.json.data.answer).toContain("#482");
    expect(answer.json.data.verifier.faithfulness).toBeGreaterThanOrEqual(0.8);
  }, 30_000);

  it("records write actions as pending approvals for the daemon", async () => {
    const result = await call("create_issue", { title: "Cap payment retries", body: "Follow-up for INC-2041" });
    expect(result.json.pending.approvalId).toBeGreaterThan(0);
    const db = path.join(env.MEADOW_HOME, "meadow.db");
    const row = execFileSync("sqlite3", [db, "SELECT a.status, p.status, a.actor FROM atlas_actions a JOIN approvals p ON p.id = a.approval_id ORDER BY a.id DESC LIMIT 1"], { encoding: "utf8" }).trim();
    expect(row).toBe("pending|pending|mcp");
  });

  it("returns tool errors instead of crashing", async () => {
    const result = await call("get_pull_request", { number: 99999 });
    expect(result.json.summary).toContain("not in the graph");
    const bad = await call("search_code", { query: "x" });
    expect(bad.isError).toBe(true);
  });
});
