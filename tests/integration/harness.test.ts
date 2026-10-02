import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide } from "../../server/meadow/core/approvals";
import { getDb } from "../../server/meadow/core/db";
import { bus, type MeadowEvent } from "../../server/meadow/core/events";
import * as git from "../../server/meadow/core/git";
import { defaultFakeScript, FakeEngine, type FakeScript } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { harness } from "../../server/meadow/harness/runner";
import { approvePlan, createProject, phasesFor, savePlanVersion, type ProjectRow } from "../../server/meadow/projects";
import { settled, tempHome, THREE_PHASE_PLAN, waitForEvent } from "../helpers";

let env: ReturnType<typeof tempHome>;
let engine: FakeEngine;
let events: MeadowEvent[];
let off: () => void;

beforeEach(() => {
  env = tempHome();
  engine = new FakeEngine();
  setEngine(engine);
  events = [];
  off = bus.onEvent(event => events.push(event));
});

afterEach(async () => {
  off();
  await harness.shutdown();
  env.cleanup();
});

async function setup(plan = THREE_PHASE_PLAN): Promise<ProjectRow> {
  const project = await createProject({ name: "demo-app", engine: "fake" });
  const row = savePlanVersion(project.id, plan);
  await approvePlan(row.id);
  return project;
}

const phaseStatuses = (projectId: number) => {
  const plan = getDb().get<{ id: number }>("SELECT id FROM plans WHERE project_id = ? AND status = 'approved'", projectId)!;
  return phasesFor(plan.id).map(phase => phase.status);
};

describe("harness with the fake engine", () => {
  it("runs a 3-phase plan to completion with a branch and commit per phase", async () => {
    const project = await setup();
    const done = settled(project.id);
    await harness.start(project.id);
    const final = await done;
    expect(final.payload?.status).toBe("completed");
    expect(phaseStatuses(project.id)).toEqual(["passed", "passed", "passed"]);
    expect(await git.currentBranch(project.path)).toBe("main");
    expect(await git.isClean(project.path)).toBe(true);
    const log = await git.git(project.path, "log", "--oneline");
    expect(log).toMatch(/phase 1 passed: Scaffold/);
    expect(log).toMatch(/phase 3 passed: Docs/);
    expect(fs.existsSync(path.join(project.path, "src/feature.js"))).toBe(true);
    const branches = await git.git(project.path, "branch");
    expect(branches).toMatch(/meadow\/phase-2-feature/);
    // every compiled prompt is stored, and later prompts carry earlier summaries
    const prompts = getDb().all<{ prompt: string }>("SELECT prompt FROM runs ORDER BY id");
    expect(prompts).toHaveLength(3);
    expect(prompts[2].prompt).toMatch(/Scaffold:/);
    expect(prompts[0].prompt).toContain("file exists: src/index.js");
    expect(events.filter(event => event.type === "phase_passed")).toHaveLength(3);
  });

  it("retries with fix prompts on failing checks, then blocks when stuck", async () => {
    const project = await setup();
    engine.setScript(() => [{ write: { path: "unrelated.txt", content: `${Math.random()}` } }, { event: { type: "done", title: "done", ok: true, reason: "completed" } }]);
    const done = settled(project.id);
    await harness.start(project.id);
    const final = await done;
    expect(final.payload?.status).toBe("blocked");
    const blocked = events.find(event => event.type === "phase_blocked")!;
    expect(blocked.payload?.failing).toBe("file exists: src/index.js");
    const runs = getDb().all<{ kind: string; prompt: string }>("SELECT kind, prompt FROM runs ORDER BY id");
    expect(runs[0].kind).toBe("initial");
    expect(runs[1].kind).toBe("fix");
    expect(runs[1].prompt).toContain("# Failing check");
    expect(runs[1].prompt).toContain("Do not weaken");
    expect(runs.length).toBeLessThanOrEqual(3);
    expect(phaseStatuses(project.id)[0]).toBe("blocked");

    // Retry with a hint and a working engine continues on the same branch and finishes.
    engine.setScript(defaultFakeScript);
    const again = settled(project.id);
    await harness.retry(project.id, "create src/index.js");
    expect((await again).payload?.status).toBe("completed");
    expect(engine.prompts.at(-3)?.prompt).toContain("create src/index.js");
  });

  it("reverts edits to PLAN.md and feeds the reason into the next attempt", async () => {
    const project = await setup();
    let call = 0;
    const script: FakeScript = (req, n) => {
      call = n;
      if (n === 0) return [{ write: { path: "PLAN.md", content: "hijacked" } }, { write: { path: "src/index.js", content: "x" } }, { event: { type: "done", title: "ok", ok: true } }];
      return defaultFakeScript(req, n);
    };
    engine.setScript(script);
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");
    expect(fs.readFileSync(path.join(project.path, "PLAN.md"), "utf8")).toContain("project: demo-app");
    expect(events.some(event => event.type === "guard" && event.detail.includes("PLAN.md"))).toBe(true);
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("blocks commits that contain secrets", async () => {
    const project = await setup();
    engine.setScript(() => [{ write: { path: "src/index.js", content: 'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";\n' } }, { event: { type: "done", title: "ok", ok: true } }]);
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("blocked");
    const log = await git.git(project.path, "log", "--all", "-p");
    expect(log).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
  });

  it("reverts symlinks that escape the project", async () => {
    const project = await setup();
    engine.setScript((req, n) => {
      if (n === 0) {
        fs.symlinkSync(env.root, path.join(req.cwd, "escape"));
        return [{ write: { path: "src/index.js", content: "x" } }, { event: { type: "done", title: "ok", ok: true } }];
      }
      return defaultFakeScript(req, n);
    });
    const done = settled(project.id);
    await harness.start(project.id);
    await done;
    expect(fs.existsSync(path.join(project.path, "escape"))).toBe(false);
    expect(events.some(event => event.type === "guard" && event.detail.includes("escape"))).toBe(true);
  });

  it("stops a hanging engine without leaving it running", async () => {
    const project = await setup();
    engine.setScript(() => [{ event: { type: "session_started", title: "s" } }, { hang: true }]);
    const started = waitForEvent(event => event.type === "session_started" && event.projectId === project.id);
    const done = settled(project.id);
    await harness.start(project.id);
    await started;
    await harness.stop(project.id);
    expect((await done).payload?.status).toBe("stopped");
    expect(harness.isActive(project.id)).toBe(false);
  });

  it("pauses and resumes", async () => {
    const project = await setup();
    const paused = settled(project.id);
    await harness.start(project.id);
    harness.pause(project.id);
    expect((await paused).payload?.status).toBe("paused");
    expect(phaseStatuses(project.id)).not.toEqual(["passed", "passed", "passed"]);
    expect(harness.isActive(project.id)).toBe(false);
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");
  });

  it("rolls back to the last passing phase and keeps the failed branch", async () => {
    const project = await setup();
    engine.setScript((req, n) => (n === 0 ? defaultFakeScript(req, n) : [{ write: { path: "junk.txt", content: `${n}` } }, { event: { type: "done", title: "ok", ok: true } }]));
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("blocked");
    const mainTip = (await git.git(project.path, "rev-parse", "main")).trim();
    await harness.rollback(project.id);
    expect(await git.currentBranch(project.path)).toBe("main");
    expect((await git.headSha(project.path))).toBe(mainTip);
    expect(fs.existsSync(path.join(project.path, "junk.txt"))).toBe(false);
    expect(await git.git(project.path, "branch")).toMatch(/failed\/phase-2-feature/);
    expect(phaseStatuses(project.id)).toEqual(["passed", "pending", "pending"]);
  });

  it("asks for approval on mass deletions and restores files when denied", async () => {
    const project = await setup();
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(project.path, `keep-${i}.txt`), "x");
    await git.commitAll(project.path, "seed files");
    engine.setScript((req, n) => [...Array.from({ length: 25 }, (_, i) => ({ remove: `keep-${i}.txt` })), ...defaultFakeScript(req, n)]);
    const requested = waitForEvent(event => event.type === "approval_requested");
    const done = settled(project.id);
    await harness.start(project.id);
    const approval = await requested;
    decide(Number(approval.payload?.approvalId), "denied", "test");
    await waitForEvent(event => event.type === "phase_passed");
    expect(fs.existsSync(path.join(project.path, "keep-3.txt"))).toBe(true);
    await harness.stop(project.id);
    await done.catch(() => undefined);
  });

  it("marks runs left running by a crash as interrupted and resumes from verification", async () => {
    const project = await setup();
    const plan = getDb().get<{ id: number }>("SELECT id FROM plans WHERE project_id = ? AND status = 'approved'", project.id)!;
    getDb().insert("executions", { project_id: project.id, plan_id: plan.id, status: "running", engine: "fake", tokens: 0, cost_usd: 0, started_at: new Date().toISOString() });
    expect(harness.recoverOnStartup()).toBe(1);
    expect(harness.latestExecution(project.id)?.status).toBe("interrupted");
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");
  });

  it("refuses to start without an approved plan", async () => {
    const project = await createProject({ name: "empty", engine: "fake" });
    await expect(harness.start(project.id)).rejects.toThrow(/approved plan/);
  });
});
