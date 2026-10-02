import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runTool, TOOLS, ToolPolicyError, type ToolDef } from "../../server/meadow/atlas/tools";
import { argsHash, auditLog, isSafeRelativePath } from "../../server/meadow/core/audit";
import { getDb } from "../../server/meadow/core/db";
import { failureReason } from "../../server/meadow/engines/base";
import { defaultFakeScript, FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { harness } from "../../server/meadow/harness/runner";
import { approvePlan, createProject, phasesFor, savePlanVersion } from "../../server/meadow/projects";
import { settled, tempHome, THREE_PHASE_PLAN } from "../helpers";

let env: ReturnType<typeof tempHome>;
let engine: FakeEngine;

beforeEach(() => {
  env = tempHome();
  engine = new FakeEngine();
  setEngine(engine);
  process.env.MEADOW_RATE_LIMIT_WAITS = "0.05,0.05";
});
afterEach(async () => {
  await harness.shutdown();
  delete process.env.MEADOW_RATE_LIMIT_WAITS;
  env.cleanup();
});

async function setup() {
  const project = await createProject({ name: "demo-app", engine: "fake" });
  await approvePlan(savePlanVersion(project.id, THREE_PHASE_PLAN).id);
  return project;
}

describe("tool policy and audit log", () => {
  it("audits read calls by argument hash and never stores the arguments", async () => {
    const project = await setup();
    await runTool("find_dependencies", { entity: "payments sk-live-abcdefghijklmnop1234" }, { projectId: project.id, actor: "mcp" });
    const [row] = auditLog(project.id);
    expect(row).toMatchObject({ tool: "find_dependencies", risk: "READ", approval: "not_required", result: "ok", agent: "mcp", user: "mcp-client" });
    expect(row.args_hash).toBe(argsHash({ entity: "payments sk-live-abcdefghijklmnop1234" }));
    const raw = JSON.stringify(getDb().all("SELECT * FROM audit_log"));
    expect(raw).not.toMatch(/sk-live/);
    expect(raw).not.toMatch(/payments/);
  });

  it("gates writes behind approval and records the pending call", async () => {
    const project = await setup();
    const result = await runTool("create_issue", { title: "Pool exhausted", body: "details" }, { projectId: project.id, actor: "agent" });
    expect(result.pending).toBeTruthy();
    const [row] = auditLog(project.id);
    expect(row).toMatchObject({ tool: "create_issue", risk: "LOW_WRITE", approval: "pending", result: "pending" });
    expect(getDb().get<{ risk: string }>("SELECT risk FROM approvals WHERE id = ?", result.pending!.approvalId)?.risk).toBe("medium");
  });

  it("rejects unknown arguments, path traversal and unknown tools, and audits the refusal", async () => {
    const project = await setup();
    const ctx = { projectId: project.id, actor: "mcp" as const };
    await expect(runTool("get_repository_map", { surprise: true }, ctx)).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(runTool("propose_patch", { title: "Fix it", description: "Change the pool size please", files: ["../../etc/passwd"] }, ctx)).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(runTool("propose_patch", { title: "Fix it", description: "Change the pool size please", files: [".env"] }, ctx)).rejects.toThrow(/relative paths inside the project/);
    await expect(runTool("rm_rf", {}, ctx)).rejects.toBeInstanceOf(ToolPolicyError);
    const refusals = auditLog(project.id).filter(row => row.result === "refused");
    expect(refusals).toHaveLength(4);
  });

  it("never lets MCP clients call destructive tools", async () => {
    const project = await setup();
    const destructive: ToolDef = { name: "wipe_branch", title: "Wipe branch", description: "test only", risk: "DESTRUCTIVE", shape: { branch: z.string() }, run: async () => ({ summary: "wiped", data: null }) };
    TOOLS.push(destructive);
    try {
      await expect(runTool("wipe_branch", { branch: "main" }, { projectId: project.id, actor: "mcp" })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
      expect(auditLog(project.id)[0]).toMatchObject({ tool: "wipe_branch", risk: "DESTRUCTIVE", approval: "refused" });
    } finally {
      TOOLS.splice(TOOLS.indexOf(destructive), 1);
    }
  });

  it("validates relative paths", () => {
    expect(isSafeRelativePath("src/app.ts")).toBe(true);
    for (const bad of ["/etc/passwd", "../x", "a/../../b", "C:\\\\win", ".meadow/config.json", ".git/config", "config/.env.local", "a\0b"]) expect(isSafeRelativePath(bad)).toBe(false);
  });
});

describe("engine rate limits", () => {
  it("recognises rate-limit messages", () => {
    expect(failureReason("Error: 429 Too Many Requests")).toBe("rate_limited");
    expect(failureReason("The model is overloaded, try again later")).toBe("rate_limited");
    expect(failureReason("invalid api key")).toBe("auth");
  });

  it("backs off and retries without spending an attempt", async () => {
    const project = await setup();
    engine.setScript((req, call) => (call === 0 ? [{ event: { type: "done", title: "429 Too Many Requests", ok: false, reason: "rate_limited" } }] : defaultFakeScript(req, call)));
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");
    const plan = getDb().get<{ id: number }>("SELECT id FROM plans WHERE project_id = ? AND status = 'approved'", project.id)!;
    expect(phasesFor(plan.id)[0].attempts).toBe(1);
    expect(getDb().all<{ title: string }>("SELECT title FROM events WHERE project_id = ? AND type = 'guard'", project.id).some(event => /rate limited/.test(event.title))).toBe(true);
  });

  it("pauses instead of blocking when the limit doesn't lift", async () => {
    const project = await setup();
    engine.setScript(() => [{ event: { type: "done", title: "rate limited", ok: false, reason: "rate_limited" } }]);
    const done = settled(project.id);
    await harness.start(project.id);
    const final = await done;
    expect(final.payload?.status).toBe("paused");
    const execution = getDb().get<{ status: string; note: string }>("SELECT status, note FROM executions WHERE project_id = ? ORDER BY id DESC", project.id)!;
    expect(execution.status).toBe("paused");
    expect(execution.note).toMatch(/no attempts were used/);
    const plan = getDb().get<{ id: number }>("SELECT id FROM plans WHERE project_id = ? AND status = 'approved'", project.id)!;
    expect(phasesFor(plan.id)[0].attempts).toBe(0);
  });
});
