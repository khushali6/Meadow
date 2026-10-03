import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../../server/meadow/config";
import { getDb } from "../../server/meadow/core/db";
import { defaultFakeScript, FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { checkEngineGuards, writeEngineGuards } from "../../server/meadow/guard/engineConfig";
import { cliPermissions } from "../../server/meadow/guard/policy";
import { harness } from "../../server/meadow/harness/runner";
import { approvePlan, createProject, savePlanVersion } from "../../server/meadow/projects";
import * as git from "../../server/meadow/core/git";
import { settled, tempHome, THREE_PHASE_PLAN } from "../helpers";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
  saveConfig({ harness: { e2e: false } });
});
afterEach(async () => {
  await harness.shutdown();
  env.cleanup();
});

async function run(engine: FakeEngine) {
  setEngine(engine);
  const project = await createProject({ name: "guarded", engine: "fake" });
  await approvePlan(savePlanVersion(project.id, THREE_PHASE_PLAN).id);
  const done = settled(project.id);
  await harness.start(project.id);
  return { project, final: await done };
}

describe("engine guardrail files", () => {
  it("writes permissions and the broker entry, keeps them out of commits, and restores them when edited", async () => {
    const project = await createProject({ name: "files", engine: "fake" });
    const before = await git.status(project.path);
    const result = await writeEngineGuards(project.path, project.id);
    expect(result.brokerAvailable).toBe(true);
    const cli = JSON.parse(fs.readFileSync(path.join(project.path, ".cursor", "cli.json"), "utf8"));
    expect(cli).toEqual(cliPermissions());
    expect(await git.status(project.path)).toEqual(before);
    expect(fs.readFileSync(path.join(project.path, ".git", "info", "exclude"), "utf8")).toContain("/.cursor/cli.json");
    const mcp = JSON.parse(fs.readFileSync(path.join(project.path, ".cursor", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.meadow.args.at(-1)).toBe("broker");
    expect(mcp.mcpServers.meadow.env.MEADOW_BROKER_PROJECT).toBe(String(project.id));
    expect(await checkEngineGuards(project.path, project.id)).toBeNull();
    fs.writeFileSync(path.join(project.path, ".cursor", "cli.json"), JSON.stringify({ permissions: { allow: ["Shell(*)"], deny: [] } }));
    expect(await checkEngineGuards(project.path, project.id)).toMatch(/restored/);
    expect(JSON.parse(fs.readFileSync(path.join(project.path, ".cursor", "cli.json"), "utf8"))).toEqual(cliPermissions());
  });
});

describe("commands the engine ran", () => {
  it("blocks the phase when the engine ran a forbidden command, and audits every command", async () => {
    const engine = new FakeEngine();
    engine.setScript((req, n) => [{ event: { type: "command_run", title: "pnpm test" } }, { event: { type: "command_run", title: "sudo rm -rf /var/db" } }, ...defaultFakeScript(req, n)]);
    const { project, final } = await run(engine);
    expect(final.payload?.status).toBe("blocked");
    const blocked = getDb().get<{ title: string; detail: string }>("SELECT title, detail FROM events WHERE project_id = ? AND type = 'phase_blocked' ORDER BY id DESC LIMIT 1", project.id)!;
    expect(blocked.title).toMatch(/forbidden command \(privilege\)/);
    expect(blocked.detail).toContain("sudo rm -rf /var/db");
    const rows = getDb().all<{ risk: string; detail: string }>("SELECT risk, detail FROM audit_log WHERE project_id = ? ORDER BY id", project.id);
    expect(rows.map(row => row.risk)).toEqual(["HIGH_WRITE", "DESTRUCTIVE"]);
  }, 30_000);

  it("blocks the phase when the engine created a Supabase project without Meadow's approval", async () => {
    const engine = new FakeEngine();
    engine.setScript((req, n) => [{ event: { type: "tool_call", title: "MCP supabase:list_projects" } }, { event: { type: "tool_call", title: "MCP supabase:create_project" } }, ...defaultFakeScript(req, n)]);
    const { project, final } = await run(engine);
    expect(final.payload?.status).toBe("blocked");
    const blocked = getDb().get<{ title: string }>("SELECT title FROM events WHERE project_id = ? AND type = 'phase_blocked' ORDER BY id DESC LIMIT 1", project.id)!;
    expect(blocked.title).toMatch(/mcp-unbrokered/);
    expect(getDb().all<{ risk: string }>("SELECT risk FROM audit_log WHERE project_id = ? AND tool LIKE 'mcp:%' ORDER BY id", project.id).map(row => row.risk)).toEqual(["READ", "DESTRUCTIVE"]);
  }, 30_000);

  it("lets the run continue but tells the engine to use Meadow for commands that need approval", async () => {
    const engine = new FakeEngine();
    engine.setScript((req, n) => [...(n === 0 ? [{ event: { type: "command_run" as const, title: "brew install postgresql" } }] : []), ...defaultFakeScript(req, n)]);
    const { project, final } = await run(engine);
    expect(final.payload?.status).toBe("completed");
    const notice = getDb().get<{ detail: string }>("SELECT detail FROM events WHERE project_id = ? AND type = 'guard' AND title = 'Guardrail notice'", project.id);
    expect(notice?.detail).toMatch(/request_system_action/);
  }, 30_000);
});
