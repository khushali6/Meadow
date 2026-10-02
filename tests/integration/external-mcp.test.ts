import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeExternalClients, listExternalTools } from "../../server/meadow/atlas/mcpClient";
import { runTool, ToolPolicyError } from "../../server/meadow/atlas/tools";
import { saveConfig } from "../../server/meadow/config";
import { getDb } from "../../server/meadow/core/db";
import { createProject } from "../../server/meadow/projects";
import { mcpCapabilities } from "../../server/meadow/setup/mcp";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
let projectId: number;

beforeAll(async () => {
  env = tempHome();
  process.env.MEADOW_ROLE = "mcp";
  saveConfig({ atlas: { mcpServers: [{ name: "fake", command: process.execPath, args: [path.resolve("tests/fixtures/fake-mcp-server.mjs")], env: [] }] } });
  projectId = (await createProject({ name: "ext", engine: "fake" })).id;
});

afterAll(async () => {
  delete process.env.MEADOW_ROLE;
  await closeExternalClients();
  env.cleanup();
});

describe("external MCP tools", () => {
  it("classifies tools and does not trust a read-only claim on a destructive name", async () => {
    const tools = await listExternalTools();
    expect(tools.map(tool => [tool.tool, tool.risk])).toEqual([["list_items", "READ"], ["create_item", "WRITE"], ["delete_item", "DESTRUCTIVE"]]);
    const caps = await mcpCapabilities("fake");
    expect(caps.reachable).toBe(true);
    expect(caps.policy.DESTRUCTIVE).toMatch(/never from MCP/);
  }, 20_000);

  it("runs read tools at once, queues writes for approval and refuses destructive calls from MCP clients", async () => {
    const read = await runTool("call_external_tool", { tool: "fake__list_items", arguments: { id: "1" } }, { projectId, actor: "mcp" });
    expect(read.summary).toBe('list_items ran with {"id":"1"}');
    expect(read.pending).toBeUndefined();

    const write = await runTool("call_external_tool", { tool: "fake__create_item", arguments: { id: "2" } }, { projectId, actor: "mcp" });
    expect(write.pending?.approvalId).toBeGreaterThan(0);
    expect(getDb().get<{ status: string; risk: string }>("SELECT status, risk FROM approvals WHERE id = ?", write.pending!.approvalId)).toMatchObject({ status: "pending", risk: "high" });

    await expect(runTool("call_external_tool", { tool: "fake__delete_item", arguments: { id: "3" } }, { projectId, actor: "mcp" })).rejects.toThrow(ToolPolicyError);
    const fromUi = await runTool("call_external_tool", { tool: "fake__delete_item", arguments: { id: "3" } }, { projectId, actor: "ui" });
    expect(fromUi.pending?.approvalId).toBeGreaterThan(0);

    await expect(runTool("call_external_tool", { tool: "fake__nope" }, { projectId, actor: "mcp" })).rejects.toThrow(/No external tool/);
    await expect(runTool("call_external_tool", { tool: "not-qualified" }, { projectId, actor: "mcp" })).rejects.toThrow();
  }, 20_000);
});
