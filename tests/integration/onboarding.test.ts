import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateAcmePay } from "../../server/meadow/atlas/demo";
import { getDb } from "../../server/meadow/core/db";
import { getSetting } from "../../server/meadow/core/settings";
import { parsePlan } from "../../server/meadow/planning/format";
import { getProject, latestPlan } from "../../server/meadow/projects";
import { analyzeRepository } from "../../server/meadow/setup/analysis";
import { diagnose } from "../../server/meadow/setup/health";
import { liveGraph } from "../../server/meadow/setup/live";
import { buildKnowledge, completeOnboarding, generateInitialPlan, initialPlanMarkdown, markStep, onboardingState, registerRepository, SetupError } from "../../server/meadow/setup/onboarding";
import { phaseSeeds, preflightImpact } from "../../server/meadow/setup/preflight";
import { autoChecks, runBaseline } from "../../server/meadow/setup/verify";
import { detectProject } from "../../server/meadow/setup/detect";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
let dir: string;
let projectId: number;

beforeAll(async () => {
  env = tempHome();
  dir = path.join(env.root, "acmepay");
  await generateAcmePay(dir);
}, 60_000);

afterAll(() => env.cleanup());

describe("onboarding", () => {
  it("starts needed, registers a repository once and refuses unsafe folders", async () => {
    expect(onboardingState().needed).toBe(true);
    await expect(registerRepository("relative/path")).rejects.toThrow(SetupError);
    await expect(registerRepository(path.join(env.root, "missing"))).rejects.toThrow(SetupError);
    await expect(registerRepository("/")).rejects.toThrow(SetupError);
    const first = await registerRepository(dir);
    expect(first.created).toBe(true);
    expect(first.project.name).toBe("acmepay");
    expect(first.profile.git.repo).toBe(true);
    const again = await registerRepository(dir + "/");
    expect(again.created).toBe(false);
    expect(again.project.id).toBe(first.project.id);
    projectId = first.project.id;
    markStep("repository", "done", dir, projectId);
    expect(onboardingState()).toMatchObject({ projectId, needed: false, steps: { repository: { status: "done" } } });
  });

  it("builds the graph and memory, then records the indexed snapshot", async () => {
    const progress: string[] = [];
    const { graph, memory } = await buildKnowledge(projectId, step => progress.push(step));
    expect(graph.services).toBeGreaterThan(3);
    expect(memory.chunks).toBeGreaterThan(0);
    expect(progress).toContain("memory");
    expect(getSetting(`live:${projectId}`)).toMatchObject({ head: expect.any(String) });
  }, 60_000);

  it("analyses architecture, risks, gaps and hotspots from the graph", () => {
    const analysis = analyzeRepository(projectId);
    expect(analysis.counts.services).toBeGreaterThan(3);
    expect(analysis.services[0].callers + analysis.services[0].apis).toBeGreaterThan(0);
    expect(analysis.services.map(service => service.name)).toContain("payment-service");
    expect(analysis.risks.length).toBeGreaterThan(0);
    expect(analysis.summary).toMatch(/## Architecture/);
  });

  it("drafts a valid initial plan once, and nothing runs until approval", () => {
    const first = generateInitialPlan(projectId);
    expect(first.created).toBe(true);
    const plan = latestPlan(projectId)!;
    expect(plan.status).toBe("draft");
    expect(plan.source).toBe("initial");
    const parsed = parsePlan(plan.raw_md);
    expect(parsed.ok).toBe(true);
    expect(parsed.plan!.phases.length).toBeGreaterThan(0);
    expect(generateInitialPlan(projectId)).toEqual({ planId: first.planId, version: first.version, created: false });
    expect(getDb().get("SELECT 1 FROM executions WHERE project_id = ?", projectId)).toBeUndefined();
  });

  it("gives every phase a check that fails now and passes once the work is done", () => {
    const phases = parsePlan(latestPlan(projectId)!.raw_md).plan!.phases;
    const run = (cmd: string) => {
      try {
        execFileSync("sh", ["-c", cmd], { cwd: dir, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    const testPhase = phases.find(phase => phase.name.startsWith("Tests for"))!;
    const cmds = testPhase.checks.filter(check => check.kind === "cmd").map(check => (check as { cmd: string }).cmd);
    expect(cmds.length).toBeGreaterThan(0);
    for (const cmd of cmds) expect(run(cmd)).toBe(false);
    for (const service of analyzeRepository(projectId).services.filter(item => testPhase.name.includes(item.name))) fs.writeFileSync(path.join(dir, service.path!, "retry.test.ts"), "it('x', () => {})\n");
    for (const cmd of cmds) expect(run(cmd)).toBe(true);
    for (const phase of phases) expect(phase.checks.some(check => check.kind === "cmd")).toBe(true);
    fs.writeFileSync(path.join(dir, "debt.ts"), "// TODO one\n// FIXME two\n");
    const markers = initialPlanMarkdown(getProject(projectId), detectProject(dir), { ...analyzeRepository(projectId), debt: [{ path: "debt.ts", markers: 2 }] }, null);
    const debtCheck = parsePlan(markers).plan!.phases.find(phase => phase.name === "Pay down marked debt")!.checks[0] as { cmd: string };
    expect(run(debtCheck.cmd)).toBe(false);
    fs.writeFileSync(path.join(dir, "debt.ts"), "// TODO one\n");
    expect(run(debtCheck.cmd)).toBe(true);
    fs.rmSync(path.join(dir, "debt.ts"));
    expect(run(debtCheck.cmd)).toBe(true);
  });

  it("puts a failing baseline first and gates later phases with passing checks", () => {
    const project = getProject(projectId);
    const markdown = initialPlanMarkdown(project, detectProject(project.path), analyzeRepository(projectId), {
      at: new Date().toISOString(),
      results: [
        { kind: "lint", cmd: "npm run lint", passed: false, exitCode: 1, durationMs: 100, output: "" },
        { kind: "test", cmd: "npm test", passed: true, exitCode: 0, durationMs: 100, output: "" },
      ],
    });
    const parsed = parsePlan(markdown);
    expect(parsed.ok).toBe(true);
    const phases = parsed.plan!.phases;
    expect(phases[0].name).toBe("Make the baseline green");
    expect(phases[0].checks).toEqual([{ kind: "cmd", cmd: "npm run lint", expectRegex: undefined, timeoutS: undefined }]);
    for (const phase of phases.slice(1)) expect(phase.dependsOn.length).toBe(1);
  });

  it("finds impact seeds for a phase that names a service or file", () => {
    const phase = { id: "1", name: "Retry payments", dependsOn: [], tasks: ["Change services/payment-service/src/retry.ts so payment-service retries less"], checks: [], doneWhen: "x" };
    expect(phaseSeeds(projectId, phase).length).toBeGreaterThan(0);
    const impact = preflightImpact(projectId, phase);
    expect(impact?.report.services.length).toBeGreaterThan(0);
    expect(impact?.text).toMatch(/payment-service/);
    expect(preflightImpact(projectId, { ...phase, name: "Nothing", tasks: ["Write a haiku"] })).toBeNull();
  });

  it("re-indexes only what changed in git and keeps the graph current", async () => {
    const file = path.join(dir, "services/payment-service/src/refunds.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export function refundPayment(id: string) {\n  return { id, refunded: true };\n}\n");
    const update = await liveGraph.refresh(projectId, "test", { forceGraph: true });
    expect(update?.files).toContain("services/payment-service/src/refunds.ts");
    expect(update?.graph).toBe(true);
    expect(getDb().get("SELECT 1 FROM chunks WHERE project_id = ? AND path = ?", projectId, "services/payment-service/src/refunds.ts")).toBeTruthy();
    expect(await liveGraph.refresh(projectId, "test")).toBeNull();
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "refunds"]);
    fs.rmSync(file);
    const removed = await liveGraph.refresh(projectId, "test", { forceGraph: true });
    expect(removed?.files).toContain("services/payment-service/src/refunds.ts");
    expect(getDb().get("SELECT 1 FROM chunks WHERE project_id = ? AND path = ?", projectId, "services/payment-service/src/refunds.ts")).toBeUndefined();
  }, 60_000);

  it("runs the baseline and enforces only commands that passed", async () => {
    const app = path.join(env.root, "tiny");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { lint: "node -e \"process.exit(1)\"", test: "node -e \"console.log('ok')\"" } }));
    const { project } = await registerRepository(app);
    const results: string[] = [];
    const baseline = await runBaseline(project.id, result => results.push(`${result.kind}:${result.passed}`));
    expect(results).toEqual(["lint:false", "test:true"]);
    expect(baseline.results[1].output).toMatch(/ok/);
    const checks = autoChecks(project.id, []);
    expect(checks).toEqual([{ kind: "cmd", cmd: "npm run test", timeoutS: 60 }]);
    expect(autoChecks(project.id, [{ kind: "cmd", cmd: "npm run test" }])).toEqual([]);
  }, 60_000);

  it("diagnoses health and finishes onboarding", async () => {
    const checks = await diagnose();
    expect(checks.map(check => check.area)).toEqual(["database", "memory", "codeatlas", "llm", "mcp", "telegram"]);
    expect(checks.find(check => check.area === "database")?.ok).toBe(true);
    expect(checks.find(check => check.area === "telegram")?.skipped).toBe(true);
    completeOnboarding();
    expect(onboardingState().completedAt).toBeTruthy();
  });
});
