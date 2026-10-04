import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../../server/meadow/config";
import { getDb } from "../../server/meadow/core/db";
import * as git from "../../server/meadow/core/git";
import { defaultFakeScript, FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { formatEvent } from "../../server/meadow/channels/notifier";
import { setSupervisorClient } from "../../server/meadow/harness/orchestrator";
import { harness } from "../../server/meadow/harness/runner";
import type { ChatMessage } from "../../server/meadow/llm/types";
import { approvePlan, createProject, savePlanVersion } from "../../server/meadow/projects";
import { settled, tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
  saveConfig({ harness: { e2e: false } });
});
afterEach(async () => {
  setSupervisorClient(undefined);
  await harness.shutdown();
  env.cleanup();
});

const FIX_PLAN = `---
project: fixme
goal: A phase that only passes once the fix agent follows the diagnosis
stack: [shell]
phases:
  - id: 1
    name: Build the module
    agent: backend
    tasks:
      - Create the module
    checks:
      - cmd: node -e "console.log(require('fs').readFileSync('.env.local','utf8'));process.exit(require('fs').existsSync('src/fixed.js')?0:1)"
    done_when: The module exists
---
`;

const PARALLEL_PLAN = (shared: boolean) => `---
project: team
goal: Two agents building independent parts at the same time
stack: [shell]
phases:
  - id: 1
    name: Scaffold
    tasks:
      - Set up the repository
    checks:
      - cmd: git rev-parse HEAD
    done_when: The repository is ready
  - id: 2
    name: Api
    agent: backend
    parallel_group: features
    depends_on: [1]
    tasks:
      - Build the API
    checks:
      - file_exists: ${shared ? "src/shared.js" : "src/api.js"}
    done_when: The API exists
  - id: 3
    name: Screens
    agent: ui
    parallel_group: features
    depends_on: [1]
    tasks:
      - Build the screens
    checks:
      - file_exists: ${shared ? "src/shared.js" : "src/screens.js"}
    done_when: The screens exist
  - id: 4
    name: Wrap up
    agent: qa
    depends_on: [2, 3]
    tasks:
      - Write the docs
    checks:
      - file_exists: docs/README.md
    done_when: Docs exist
---
`;

describe("supervisor agent", () => {
  it("diagnoses a failed attempt, hands the fix agent its instructions, and never sees project secrets", async () => {
    const seen: ChatMessage[][] = [];
    setSupervisorClient({ label: "test-qwen", chat: async messages => { seen.push(messages); return { text: JSON.stringify({ action: "retry", diagnosis: "src/fixed.js was never created.", hint: "Create src/fixed.js exporting the module." }), model: "test", tokensIn: 1, tokensOut: 1 }; } });
    const engine = new FakeEngine((req, call) => {
      const steps = defaultFakeScript(req, call);
      return req.prompt.includes("Create src/fixed.js exporting the module.") ? [{ write: { path: "src/fixed.js", content: "module.exports = 1;\n" } }, ...steps] : steps;
    });
    setEngine(engine);
    const project = await createProject({ name: "fixme", engine: "fake" });
    fs.writeFileSync(path.join(project.path, ".env.local"), "SECRET_TOKEN=very-private-value-42\n", { mode: 0o600 });
    await approvePlan(savePlanVersion(project.id, FIX_PLAN).id);
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");

    expect(engine.prompts).toHaveLength(2);
    expect(engine.prompts[1].prompt).toContain("Supervisor's diagnosis");
    expect(engine.prompts[1].prompt).toContain("src/fixed.js was never created.");
    expect(seen).toHaveLength(1);
    const sent = seen[0].map(message => message.content).join("\n");
    expect(sent).toContain("backend agent");
    expect(sent).not.toContain("very-private-value-42");

    const event = getDb().get<{ id: number; title: string; detail: string; payload_json: string }>("SELECT * FROM events WHERE project_id = ? AND type = 'supervisor'", project.id)!;
    expect(event.title).toContain("retrying with a diagnosis");
    const card = formatEvent({ id: event.id, projectId: project.id, executionId: null, runId: null, phaseId: null, ts: "", type: "supervisor", title: event.title, detail: event.detail, payload: JSON.parse(event.payload_json) });
    expect(card?.text).toContain("🧭");
    expect(card?.text).toContain("test-qwen");

    const finished = getDb().get<{ payload_json: string }>("SELECT payload_json FROM events WHERE project_id = ? AND type = 'execution_finished'", project.id)!;
    const team = JSON.parse(finished.payload_json).team;
    expect(team).toEqual([expect.objectContaining({ agent: "backend", attempts: 2, status: "passed", notes: ["src/fixed.js was never created."] })]);
  }, 30_000);

  it("stops a hopeless loop early when it says only the user can unblock it", async () => {
    setSupervisorClient({ label: "test-qwen", chat: async () => ({ text: '{"action":"escalate","diagnosis":"The API key in .env.local is empty, so the client can never authenticate.","hint":""}', model: "test", tokensIn: 1, tokensOut: 1 }) });
    const engine = new FakeEngine();
    setEngine(engine);
    const project = await createProject({ name: "hopeless", engine: "fake" });
    fs.writeFileSync(path.join(project.path, ".env.local"), "X=1\n");
    await approvePlan(savePlanVersion(project.id, FIX_PLAN).id);
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("blocked");
    expect(engine.prompts).toHaveLength(2);
    const blocked = getDb().get<{ title: string; detail: string }>("SELECT title, detail FROM events WHERE project_id = ? AND type = 'phase_blocked'", project.id)!;
    expect(blocked.title).toContain("the supervisor says it needs you");
    expect(blocked.detail).toContain("Supervisor: The API key in .env.local is empty");
  }, 30_000);
});

describe("parallel agents", () => {
  it("runs a parallel group at the same time in separate worktrees and merges both into main", async () => {
    setEngine(new FakeEngine((req, call) => defaultFakeScript(req, call).map(step => ({ ...step, delayMs: ("delayMs" in step ? step.delayMs ?? 0 : 0) + 150 }))));
    const project = await createProject({ name: "team", engine: "fake" });
    await approvePlan(savePlanVersion(project.id, PARALLEL_PLAN(false)).id);
    const done = settled(project.id);
    await harness.start(project.id);
    const finished = await done;
    const why = getDb().all<{ title: string; detail: string }>("SELECT title, detail FROM events WHERE project_id = ? AND type IN ('phase_blocked','error','guard')", project.id);
    expect(finished.payload?.status, JSON.stringify(why)).toBe("completed");

    expect(await git.currentBranch(project.path)).toBe(project.base_branch);
    for (const file of ["src/api.js", "src/screens.js", "docs/README.md"]) expect(fs.existsSync(path.join(project.path, file)), file).toBe(true);
    expect(await git.worktrees(project.path)).toEqual([]);

    const runs = getDb().all<{ phase_id: number; started_at: string; finished_at: string }>("SELECT r.phase_id, r.started_at, r.finished_at FROM runs r JOIN phases p ON p.id = r.phase_id WHERE p.phase_key IN ('2','3') ORDER BY r.id");
    expect(runs).toHaveLength(2);
    expect(runs[1].started_at < runs[0].finished_at).toBe(true);

    expect(getDb().get("SELECT id FROM events WHERE project_id = ? AND title = '2 agents working in parallel'", project.id)).toBeTruthy();
    const passed = getDb().all<{ payload_json: string }>("SELECT payload_json FROM events WHERE project_id = ? AND type = 'phase_passed'", project.id).map(row => JSON.parse(row.payload_json));
    expect(passed.filter(payload => payload.parallel).map(payload => payload.team.agent).sort()).toEqual(["backend", "ui"]);
    const log = await git.git(project.path, "log", "--oneline", project.base_branch);
    expect(log).toMatch(/merge phase 2: Api/);
    expect(log).toMatch(/merge phase 3: Screens/);
  }, 60_000);

  it("has the later agent merge main into its branch and resolve the conflict, like a developer would", async () => {
    const engine = new FakeEngine((req, call) => {
      const steps = defaultFakeScript(req, call);
      const phase = req.prompt.match(/# This phase: (.+)/)?.[1]?.trim() ?? req.prompt.match(/^Phase: (.+?) \(attempt/m)?.[1]?.trim() ?? "";
      return phase === "Screens" ? [{ write: { path: "src/screens-wip.js", content: "// wip\n" }, delayMs: 400 }, ...steps] : steps;
    });
    setEngine(engine);
    const project = await createProject({ name: "clash", engine: "fake" });
    await approvePlan(savePlanVersion(project.id, PARALLEL_PLAN(true)).id);
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");

    expect(getDb().get("SELECT id FROM events WHERE project_id = ? AND title = 'UI agent is resolving a merge conflict with another agent'", project.id)).toBeTruthy();
    const resolution = engine.prompts.find(req => req.prompt.includes("That merge is now in progress in this worktree"));
    expect(resolution?.prompt).toContain("src/shared.js");
    expect(fs.readFileSync(path.join(project.path, "src/shared.js"), "utf8")).not.toMatch(/^(<<<<<<<|>>>>>>>)/m);
    expect(await git.worktrees(project.path)).toEqual([]);
    const log = await git.git(project.path, "log", "--oneline", project.base_branch);
    expect(log).toMatch(/merge phase 2: Api/);
    expect(log).toMatch(/merge phase 3: Screens/);
  }, 60_000);
});
