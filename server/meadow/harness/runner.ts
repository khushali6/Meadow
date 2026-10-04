import fs from "node:fs";
import path from "node:path";
import { engineModel, getSecret, homePath, loadConfig } from "../config";
import { requestApproval } from "../core/approvals";
import { getDb, now } from "../core/db";
import { bus, type EventType } from "../core/events";
import { minimalEnv } from "../core/exec";
import * as git from "../core/git";
import { tail } from "../core/redact";
import type { CaseResult } from "../visual/e2e";
import { meadowOverlapMessage, overlapsMeadow } from "../core/self";
import type { Engine, EngineEvent } from "../engines/base";
import { assertSelectableEngine, getEngine } from "../engines/registry";
import { executionOrder, SERVICES_PHASE_ID, type Check, type Plan, type PlanPhase } from "../planning/format";
import { getProject, parsedActivePlan, phasesFor, projectRules, touchProject, type PhaseRow, type ProjectRow } from "../projects";
import { indexMemory, indexProject, promptContext } from "../rag/index";
import { captureRoutes } from "../visual/capture";
import { detectLaunch, launchApp } from "../visual/launch";
import { startPreview, type PreviewHandle } from "../visual/preview";
import { projectBrief } from "../brief/brief";
import { projectStatus } from "../brief/next";
import { liveGraph } from "../setup/live";
import { preflightImpact } from "../setup/preflight";
import { assertEngineReady } from "../setup/engines";
import { autoChecks } from "../setup/verify";
import { ACCEPTANCE_KEY, E2E_CHECK, acceptanceApplies, acceptancePhase, acceptanceRow, ensureAcceptanceRow, runAcceptance, type AcceptanceResult } from "./acceptance";
import { runGuards } from "./guards";
import { audit } from "../core/audit";
import { startBrokerExecutor } from "../guard/broker";
import { ensureGithubRepo, pushBase } from "../services/github";
import { connectedServices, engineMcpStatus } from "../services/registry";
import { checkEngineGuards, writeEngineGuards } from "../guard/engineConfig";
import { classifyCommand, classifyMcpCall, type Verdict } from "../guard/policy";
import { compileFixPrompt, compilePhasePrompt, rulesFileContent } from "./prompts";
import { generateProjectDocs } from "./docs";
import { generateUiDesignBrief, isWebPlan } from "./design";
import { copyEnvFiles, ENV_FILE, missingEnv, writeEnvScaffold } from "./env";
import { diagnoseFailure, roleLabel, supervisorAvailable, teamReport, type SupervisorVerdict, type TeamMember } from "./orchestrator";
import { runDesignReview, touchesUi, uiGateApplies } from "./uigate";
import { summarizePhase } from "./summarize";
import { verify, type CheckOutcome } from "./verifier";

function nextRecommendation(projectId: number): string | null {
  try {
    const next = projectStatus(projectId).suggestions[0];
    return next ? `Recommended next: ${next.label}. ${next.detail}` : null;
  } catch {
    return null;
  }
}

/** Backoff between engine rate-limit retries, in seconds. MEADOW_RATE_LIMIT_WAITS overrides it (comma-separated). */
function rateLimitWaits(): number[] {
  const custom = process.env.MEADOW_RATE_LIMIT_WAITS?.split(",").map(Number).filter(value => Number.isFinite(value) && value >= 0);
  return custom?.length ? custom : [30, 60, 120, 300];
}

export type ExecutionStatus = "running" | "paused" | "waiting" | "blocked" | "stopped" | "completed" | "interrupted" | "failed";
export type ExecutionRow = { id: number; project_id: number; plan_id: number; status: ExecutionStatus; engine: string; current_phase_id: number | null; tokens: number; cost_usd: number; note: string | null; started_at: string; finished_at: string | null };

type Active = {
  executionId: number;
  projectId: number;
  engine: Engine;
  abort: AbortController;
  pauseRequested: boolean;
  stopRequested: boolean;
  engineRunKeys: Set<string>;
  hint: string | null;
  budgetOverride: boolean;
  servicesOverride: boolean;
  envOverride: boolean;
  lastE2e: { results: CaseResult[]; runHow: string | null; url: string | null } | null;
  /** While a parallel group runs, the first park request is held here until every agent in the group stops. */
  deferPark: boolean;
  pendingPark: { phase: PhaseRow | null; status: "paused" | "waiting" | "blocked"; note: string } | null;
  /** Parallel agents share one preview port and one main checkout. */
  previewLock: Semaphore;
  mergeLock: Semaphore;
  team: TeamMember[];
};

type PhaseOutcome = "passed" | "blocked" | "paused" | "stopped";

/** Execution note that makes the next resume build without the missing environment variables. */
export const ENV_SKIPPED_NOTE = "Env skipped by the user.";

const RESUMABLE: ExecutionStatus[] = ["paused", "waiting", "blocked", "interrupted"];
const SPECIFIC_FAILURES = new Set(["auth", "missing_binary", "model_unavailable", "rate_limited"]);
const minFreeDiskMb = () => Number(process.env.MEADOW_MIN_FREE_DISK_MB ?? 500);

export function freeDiskMb(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
  } catch {
    return null;
  }
}

export function engineLoginHint(engine: string): string {
  return engine === "custom" || engine === "fake" ? "Check the engine with `meadow doctor`" : "Open Setup → Coding engine and click Connect (or save an API key there)";
}

/** Limits concurrent holders; the rest queue in order. */
class Semaphore {
  private queue: Array<() => void> = [];
  private held = 0;
  constructor(private capacity: () => number = () => 1) {}
  async acquire(): Promise<() => void> {
    if (this.held >= Math.max(1, this.capacity())) await new Promise<void>(resolve => this.queue.push(resolve));
    else this.held += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.held -= 1;
    };
  }
  get waiting() {
    return this.queue.length;
  }
}

/** Engine runs that may happen at once across all projects: one, or harness.parallel.maxAgents when parallel agents are on. */
const engineCapacity = () => {
  const parallel = loadConfig().harness.parallel;
  return parallel?.enabled ? Math.min(8, Math.max(1, parallel.maxAgents)) : 1;
};

/** A phase running in its own git worktree as part of a parallel group. */
type Worktree = { dir: string; mainPath: string };

/** Fails while any tracked file still has merge conflict markers. */
const CONFLICT_CHECK: Check = { kind: "cmd", cmd: "if git grep -nIE '^(<<<<<<<|>>>>>>>)( |$)'; then echo 'Merge conflict markers are still in the files above.'; exit 1; fi" };

const slug = (text: string, max = 32) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, max);
const phaseBranch = (phase: PlanPhase) => `meadow/phase-${phase.id}-${slug(phase.name)}`;
export const worktreeDir = (project: Pick<ProjectRow, "id" | "name">, phase: Pick<PlanPhase, "id">) => homePath("worktrees", `${project.id}-${slug(project.name, 40) || "project"}`, `phase-${slug(String(phase.id), 20)}`);

export class Harness {
  private active = new Map<number, Active>();
  private engineSlot = new Semaphore(engineCapacity);

  isActive(projectId: number) {
    return this.active.has(projectId);
  }

  activeProjectIds(): number[] {
    return [...this.active.keys()];
  }

  latestExecution(projectId: number): ExecutionRow | undefined {
    return getDb().get<ExecutionRow>("SELECT * FROM executions WHERE project_id = ? ORDER BY id DESC LIMIT 1", projectId);
  }

  getExecution(id: number): ExecutionRow {
    const row = getDb().get<ExecutionRow>("SELECT * FROM executions WHERE id = ?", id);
    if (!row) throw new Error(`Execution ${id} not found`);
    return row;
  }

  /** At startup, anything left running by a crashed daemon becomes interrupted; the user chooses resume or retry. */
  recoverOnStartup() {
    const db = getDb();
    const stale = db.all<ExecutionRow>("SELECT * FROM executions WHERE status = 'running'");
    for (const execution of stale) {
      db.update("executions", execution.id, { status: "interrupted", note: "Meadow stopped while this run was active." });
      db.run("UPDATE phases SET status = 'interrupted' WHERE plan_id = ? AND status IN ('preparing','running','verifying','fixing')", execution.plan_id);
      db.run("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE execution_id = ? AND status = 'running'", now(), execution.id);
      bus.emitEvent({ type: "control", projectId: execution.project_id, executionId: execution.id, title: "Run interrupted", detail: "Meadow restarted while this run was active. Resume to continue from the last verified state.", payload: { status: "interrupted" } });
    }
    return stale.map(execution => execution.project_id);
  }

  /** With harness.autoResume on, interrupted runs continue on their own after a restart (verified state only). */
  autoResume(projectIds: number[]) {
    if (!loadConfig().harness.autoResume) return [];
    const resumed: number[] = [];
    for (const projectId of [...new Set(projectIds)]) {
      this.start(projectId).then(() => resumed.push(projectId)).catch(error => {
        bus.emitEvent({ type: "control", projectId, title: "Auto-resume skipped", detail: (error as Error).message, payload: { status: "interrupted" } });
      });
    }
    return resumed;
  }

  /** Start a new execution, or resume the latest paused/blocked/interrupted/waiting one. */
  async start(projectId: number, options: { engine?: string; hint?: string } = {}): Promise<number> {
    if (this.active.has(projectId)) return this.active.get(projectId)!.executionId;
    const project = getProject(projectId);
    const active = parsedActivePlan(projectId);
    if (!active) throw new Error("This project has no approved plan yet. Create or import a plan and approve it first.");
    const meadowRoot = overlapsMeadow(project.path);
    if (meadowRoot) throw new Error(meadowOverlapMessage(project.path, meadowRoot));
    const freeMb = freeDiskMb(project.path);
    if (freeMb !== null && freeMb < minFreeDiskMb()) throw new Error(`Only ${freeMb} MB of disk space is free. Free up at least ${minFreeDiskMb()} MB (installs and builds need room), then start again.`);
    const engineName = options.engine ?? project.engine;
    assertSelectableEngine(engineName);
    await assertEngineReady(engineName);
    if (this.active.has(projectId)) return this.active.get(projectId)!.executionId;
    const engine = getEngine(engineName);
    const previous = this.latestExecution(projectId);
    let executionId: number;
    if (previous && previous.plan_id === active.row.id && RESUMABLE.includes(previous.status)) {
      executionId = previous.id;
      getDb().update("executions", executionId, { status: "running", engine: engineName, note: null, finished_at: null });
    } else {
      executionId = getDb().insert("executions", { project_id: projectId, plan_id: active.row.id, status: "running", engine: engineName, tokens: 0, cost_usd: 0, started_at: now() });
    }
    const state: Active = { executionId, projectId, engine, abort: new AbortController(), pauseRequested: false, stopRequested: false, engineRunKeys: new Set(), hint: options.hint ?? null, budgetOverride: previous?.note?.startsWith("Budget") ?? false, servicesOverride: previous?.note?.startsWith("Services") ?? false, envOverride: previous?.note?.startsWith(ENV_SKIPPED_NOTE) ?? false, lastE2e: null, deferPark: false, pendingPark: null, previewLock: new Semaphore(), mergeLock: new Semaphore(), team: [] };
    this.active.set(projectId, state);
    startBrokerExecutor();
    this.emit(state, "execution_started", `Run started on ${engine.label}`, `${active.plan.phases.length} phases · plan v${active.row.version}`);
    this.loop(state, project, active.plan, active.row.id).catch(error => {
      this.finish(state, "failed", `Harness error: ${(error as Error).message}`);
    });
    return executionId;
  }

  pause(projectId: number) {
    const state = this.active.get(projectId);
    if (!state) throw new Error("Nothing is running for this project.");
    state.pauseRequested = true;
    this.emit(state, "control", "Pause requested", "The current engine step will finish, then the run pauses.");
  }

  async stop(projectId: number) {
    const state = this.active.get(projectId);
    if (!state) {
      const latest = this.latestExecution(projectId);
      if (latest && RESUMABLE.includes(latest.status)) {
        getDb().update("executions", latest.id, { status: "stopped", finished_at: now() });
        bus.emitEvent({ type: "control", projectId, executionId: latest.id, title: "Run stopped", detail: "", payload: { status: "stopped" } });
      }
      return;
    }
    state.stopRequested = true;
    state.abort.abort();
    await Promise.all([...state.engineRunKeys].map(key => state.engine.cancel(key)));
    this.emit(state, "control", "Stop requested", "Cancelling the engine and stopping the run.");
  }

  async retry(projectId: number, hint?: string) {
    if (this.active.has(projectId)) throw new Error("A run is already active; pause or stop it first.");
    return this.start(projectId, { hint });
  }

  async skipPhase(projectId: number) {
    if (this.active.has(projectId)) throw new Error("Stop or pause the run before skipping a phase.");
    const project = getProject(projectId);
    const phase = this.currentPhase(projectId);
    if (!phase) throw new Error("No phase to skip.");
    if (phase.branch) await git.preserveAndReset(project.path, phase.branch, project.base_branch);
    getDb().update("phases", phase.id, { status: "skipped", finished_at: now() });
    bus.emitEvent({ type: "control", projectId, phaseId: phase.id, title: `Skipped phase: ${phase.name}`, detail: "Its branch was kept under failed/ for inspection." });
  }

  /** Reset to the last passing phase (the base branch tip). The failed branch is kept under failed/. */
  async rollback(projectId: number) {
    if (this.active.has(projectId)) await this.stop(projectId);
    for (let i = 0; i < 100 && this.active.has(projectId); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const project = getProject(projectId);
    const phase = this.currentPhase(projectId);
    const branch = await git.currentBranch(project.path);
    const failedBranch = phase?.branch ?? (branch !== project.base_branch ? branch : null);
    if (failedBranch) await git.preserveAndReset(project.path, failedBranch, project.base_branch);
    else await git.resetHard(project.path, project.base_branch);
    if (phase) getDb().update("phases", phase.id, { status: "pending", attempts: 0, branch: null, started_at: null });
    const latest = this.latestExecution(projectId);
    if (latest && latest.status !== "completed") getDb().update("executions", latest.id, { status: "stopped", finished_at: now() });
    bus.emitEvent({ type: "control", projectId, phaseId: phase?.id ?? null, title: "Rolled back to the last passing phase", detail: failedBranch ? `${failedBranch} was preserved under failed/.` : `Reset to ${project.base_branch}.`, payload: { status: "stopped" } });
  }

  currentPhase(projectId: number): PhaseRow | undefined {
    const active = parsedActivePlan(projectId);
    if (!active) return undefined;
    const rows = phasesFor(active.row.id);
    const order = executionOrder(active.plan.phases).map(phase => rows.find(row => row.phase_key === phase.id)!);
    const acceptance = acceptanceRow(active.row.id);
    return [...order, ...(acceptance ? [acceptance] : [])].find(row => row && !["passed", "skipped"].includes(row.status));
  }

  private emit(state: Active, type: EventType, title: string, detail = "", extra: { runId?: number | null; phaseId?: number | null; payload?: Record<string, unknown> } = {}) {
    return bus.emitEvent({ type, title, detail, projectId: state.projectId, executionId: state.executionId, runId: extra.runId ?? null, phaseId: extra.phaseId ?? null, payload: extra.payload });
  }

  private finish(state: Active, status: ExecutionStatus, note: string | null, extra: Record<string, unknown> = {}) {
    const terminal = ["completed", "stopped", "failed"].includes(status);
    getDb().update("executions", state.executionId, { status, note, finished_at: terminal ? now() : null });
    this.active.delete(state.projectId);
    touchProject(state.projectId);
    this.emit(state, "execution_finished", status === "completed" ? "All phases passed" : `Run ${status}`, note ?? "", { payload: { ...extra, status } });
  }

  /** Sleeps in short steps so pause and stop take effect during a rate-limit wait. Returns false when interrupted. */
  private async waitInterruptibly(state: Active, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (state.stopRequested || state.pauseRequested) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, until - Date.now())));
    }
    return true;
  }

  private setPhase(phase: PhaseRow, patch: Partial<Pick<PhaseRow, "status" | "branch" | "attempts" | "summary" | "commit_sha" | "started_at" | "finished_at">>) {
    getDb().update("phases", phase.id, patch as Record<string, string | number | null>);
    Object.assign(phase, patch);
  }

  private async loop(state: Active, project: ProjectRow, plan: Plan, planId: number) {
    const repo = await ensureGithubRepo(project).catch(error => ({ status: "skipped" as const, detail: `GitHub: ${(error as Error).message}`, url: undefined }));
    if (repo.status === "created") this.emit(state, "message", "Created a private GitHub repository", `${repo.detail}${repo.url ? `\n${repo.url}` : ""}`);
    const rows = phasesFor(planId);
    if ((await this.servicesGate(state, project, plan, rows)) === "parked") return;
    if ((await this.envGate(state, project, plan)) === "parked") return;

    // Generate a unique per-project design brief from plan.ui.prompt before any phase runs.
    if (plan.ui?.prompt && isWebPlan(plan)) {
      try {
        this.emit(state, "message", "Generating design system", `Visual direction: "${plan.ui.prompt.slice(0, 120)}${plan.ui.prompt.length > 120 ? "…" : ""}"`);
        await generateUiDesignBrief(plan, project.path, state.abort.signal);
        // Commit the generated design brief so the working tree is clean when phase 1 starts.
        await git.commitAll(project.path, "meadow: generate .meadow/design.md").catch(() => undefined);
        this.emit(state, "message", "Design system ready", "Unique palette, typography and motion spec written to .meadow/design.md — all phases will follow it.");
      } catch {
        // Non-fatal — phases proceed with the universal DESIGN_STANDARD.
      }
    }

    const ordered = executionOrder(plan.phases);
    const done = (id: string) => ["passed", "skipped"].includes(rows.find(item => item.phase_key === id)?.status ?? "");
    for (const phase of ordered) {
      const row = rows.find(item => item.phase_key === phase.id)!;
      if (["passed", "skipped"].includes(row.status)) continue;
      const blockedDep = phase.dependsOn.find(dep => rows.find(item => item.phase_key === dep)?.status === "skipped");
      if (blockedDep) this.emit(state, "message", `Note: ${phase.name} depends on a skipped phase`, `Phase ${blockedDep} was skipped; this phase may fail.`, { phaseId: row.id });
      if (state.stopRequested) return this.finish(state, "stopped", null);
      if (state.pauseRequested) return this.park(state, row, "paused", "Paused before the next phase.");
      getDb().update("executions", state.executionId, { current_phase_id: row.id });
      const parallel = loadConfig().harness.parallel;
      const group = phase.parallelGroup && parallel?.enabled ? ordered.filter(item => item.parallelGroup === phase.parallelGroup && !done(item.id) && item.dependsOn.every(done)).slice(0, Math.max(1, parallel.maxAgents)) : [];
      const outcome = group.length > 1 ? await this.runGroup(state, project, plan, group, rows, ordered) : await this.runPhase(state, project, plan, phase, row, ordered);
      if (outcome === "stopped") return this.finish(state, "stopped", null);
      if (outcome === "paused") return;
      if (outcome === "blocked") return;
      const remaining = ordered.slice(ordered.indexOf(phase) + 1).some(next => !["passed", "skipped"].includes(rows.find(item => item.phase_key === next.id)!.status));
      if (remaining && loadConfig().harness.phaseGate === "ask") {
        return this.park(state, null, "waiting", "Phase passed. Waiting for you to continue.");
      }
    }
    const accepted = await this.acceptance(state, project, plan, planId, ordered);
    if (accepted === "stopped") return this.finish(state, "stopped", null);
    if (accepted === "paused" || accepted === "blocked") return;

    // Generate project docs (.meadow/docs/) after all phases pass.
    await this.generateDocs(state, project, plan);

    if (accepted === "passed" && state.lastE2e) {
      const { results, runHow, url } = state.lastE2e;
      return this.finish(state, "completed", nextRecommendation(project.id), { screenshotIds: [], runHow, url, e2e: { passed: results.filter(result => result.passed).length, total: results.length }, team: state.team });
    }
    const showcase = await this.showcase(state, project, plan);
    this.finish(state, "completed", nextRecommendation(project.id), { ...showcase, team: state.team });
  }

  /**
   * After the plan's phases: run the whole app in a real browser, click through every main flow, and hand any
   * error back to the engine. Only a fully passing run sends screenshots to the user.
   */
  private async acceptance(state: Active, project: ProjectRow, plan: Plan, planId: number, ordered: PlanPhase[]): Promise<PhaseOutcome | "skipped"> {
    if (!loadConfig().harness.e2e) return "skipped";
    const applies = await acceptanceApplies(project.path, plan);
    if ("reason" in applies) {
      this.emit(state, "message", "End-to-end browser tests skipped", applies.reason);
      return "skipped";
    }
    const row = await ensureAcceptanceRow(planId, project.path, project.base_branch);
    if (row.status === "skipped") return "skipped";
    if (row.status === "passed") return "passed";
    if (state.stopRequested) return "stopped";
    if (state.pauseRequested) {
      this.park(state, row, "paused", "Paused before the end-to-end tests.");
      return "paused";
    }
    getDb().update("executions", state.executionId, { current_phase_id: row.id });
    const phase = acceptancePhase(plan);
    return this.runPhase(state, project, plan, phase, row, [...ordered, phase]);
  }

  /**
   * Phases in one parallel group: each agent works on its own branch in its own git worktree at the same time,
   * and each passing branch is merged into the base branch. A park request waits until every agent has stopped.
   */
  private async runGroup(state: Active, project: ProjectRow, plan: Plan, group: PlanPhase[], rows: PhaseRow[], ordered: PlanPhase[]): Promise<PhaseOutcome> {
    const rowOf = (phase: PlanPhase) => rows.find(item => item.phase_key === phase.id)!;
    try {
      const current = await git.currentBranch(project.path);
      if (current !== project.base_branch) {
        if (!(await git.isClean(project.path))) throw new Error(`The project is on ${current} with uncommitted changes. Roll back or commit them first.`);
        await git.checkout(project.path, project.base_branch);
      }
      if (!(await git.isClean(project.path))) throw new Error(`The working tree on ${project.base_branch} has uncommitted changes (${(await git.status(project.path)).slice(0, 5).map(entry => entry.path).join(", ")}). Commit or discard them, then resume.`);
      if (state.engine.writeRules) {
        state.engine.writeRules(project.path, rulesFileContent(plan, projectRules(project), project.path));
        await git.commitAll(project.path, "meadow: update engine rules");
      }
      const base = await git.headSha(project.path);
      for (const phase of group) {
        const row = rowOf(phase);
        const branch = row.branch ?? phaseBranch(phase);
        const dir = worktreeDir(project, phase);
        await git.addWorktree(project.path, dir, branch, base);
        copyEnvFiles(project.path, dir);
        if (row.branch !== branch) this.setPhase(row, { branch });
      }
    } catch (error) {
      const row = rowOf(group[0]);
      const message = (error as Error).message;
      this.setPhase(row, { status: "blocked" });
      this.emit(state, "phase_blocked", `Parallel phases could not start: ${group.map(phase => phase.name).join(", ")}`, message, { phaseId: row.id, payload: { reason: "prepare", lastError: message } });
      this.park(state, row, "blocked", message);
      return "blocked";
    }
    this.emit(state, "message", `${group.length} agents working in parallel`, group.map(phase => `${roleLabel(phase.agent)}: ${phase.name}`).join("\n"), { payload: { parallel: true, phases: group.map(phase => phase.id) } });
    state.deferPark = true;
    let outcomes: PhaseOutcome[];
    try {
      outcomes = await Promise.all(group.map(phase => {
        const row = rowOf(phase);
        const dir = worktreeDir(project, phase);
        return this.runPhase(state, { ...project, path: dir }, plan, phase, row, ordered, { dir, mainPath: project.path }).catch((error): PhaseOutcome => {
          const message = (error as Error).message;
          this.setPhase(row, { status: "blocked" });
          this.emit(state, "phase_blocked", `Phase failed unexpectedly: ${phase.name}`, message, { phaseId: row.id, payload: { lastError: message } });
          this.park(state, row, "blocked", `${phase.name}: ${message}`);
          return "blocked";
        });
      }));
    } finally {
      state.deferPark = false;
    }
    if (outcomes.includes("stopped")) return "stopped";
    const pending = state.pendingPark;
    if (pending) {
      state.pendingPark = null;
      this.park(state, pending.phase, pending.status, pending.note);
      return pending.status === "blocked" ? "blocked" : "paused";
    }
    return "passed";
  }

  /** The finished app, running, as a person would see it: desktop and mobile screenshots plus how to run it. */
  private async showcase(state: Active, project: ProjectRow, plan: Plan): Promise<Record<string, unknown>> {
    const config = loadConfig();
    if (!project.screenshots || !config.screenshots.enabled) return { screenshotIds: [], runHow: null };
    let handle: PreviewHandle | null = null;
    try {
      const spec = await detectLaunch(project.path, plan);
      if (!spec) {
        this.emit(state, "message", "No web page to screenshot", "This project has no preview block, dev script, Python web app or index.html, so there is nothing to open in a browser.");
        return { screenshotIds: [], runHow: null };
      }
      this.emit(state, "message", "Opening the finished app in a browser", spec.how);
      handle = await launchApp(spec, project.path, detail => this.emit(state, "message", detail, ""));
      const { shots, skipped } = await captureRoutes({ baseUrl: handle.url, routes: spec.routes, projectPath: project.path, projectId: project.id, phaseId: null, folder: `final-${state.executionId}` });
      for (const shot of shots) this.emit(state, "screenshot", `Final screenshot ${shot.label}`, shot.path, { payload: { screenshotId: shot.id, route: shot.route, viewport: shot.viewport, final: true } });
      for (const reason of skipped) this.emit(state, "message", "Screenshot skipped", reason);
      return { screenshotIds: shots.map(shot => shot.id), runHow: spec.how, url: handle.url };
    } catch (error) {
      this.emit(state, "error", "Couldn't open the finished app for screenshots", (error as Error).message.slice(0, 1500));
      return { screenshotIds: [], runHow: null };
    } finally {
      handle?.stop();
    }
  }

  /**
   * Before any phase: the services the plan needs must be usable by the engine. Otherwise the run waits with a
   * sign-in card; resuming anyway builds without them (the built-in services phase is skipped).
   */
  private async servicesGate(state: Active, project: ProjectRow, plan: Plan, rows: PhaseRow[]): Promise<"ok" | "parked"> {
    const wanted = plan.services.filter(name => name !== "github");
    const servicesRow = rows.find(item => item.phase_key === SERVICES_PHASE_ID);
    if (!wanted.length || (servicesRow && ["passed", "skipped"].includes(servicesRow.status))) return "ok";
    const available = await connectedServices(project.path).catch(() => []);
    const missing = wanted.map(name => ({ name, service: available.find(item => item.name === name) })).filter(item => item.service?.status !== "ready");
    if (!missing.length) return "ok";
    const names = missing.map(item => item.name).join(", ");
    if (state.servicesOverride) {
      if (servicesRow) this.setPhase(servicesRow, { status: "skipped", summary: `Skipped: ${names} not connected`, finished_at: now() });
      state.hint = [state.hint, `The user chose to build without ${names}. Use local alternatives (SQLite instead of Supabase, no containers instead of Docker) and say so in your report.`].filter(Boolean).join("\n");
      this.emit(state, "message", `Building without ${names}`, "Meadow will use local alternatives.");
      return "ok";
    }
    for (const { name, service } of missing) {
      const needsLogin = service?.status === "needs_login";
      this.emit(state, "setup", needsLogin ? `${name} needs a one-time sign-in` : `${name} isn't available`, `${service?.detail ?? `${name} isn't connected in Cursor.`} ${service?.fix ?? `Connect ${name} in Cursor Settings → MCP.`}\nThe run continues when you resume.`, { payload: { service: name, needsLogin, ok: false } });
    }
    this.park(state, null, "waiting", `Services: ${names} not ready. Sign in and resume, or resume to build without them.`);
    return "parked";
  }

  /**
   * Before any phase: every required environment variable in the plan must have a value in .env.local.
   * Meadow writes empty placeholders and waits; the user fills them in. Meadow only checks that a value is set.
   */
  private async envGate(state: Active, project: ProjectRow, plan: Plan): Promise<"ok" | "parked"> {
    if (!plan.env?.required.length && !plan.env?.optional.length) return "ok";
    try {
      const changed = writeEnvScaffold(project.path, plan);
      const isIgnored = (file: string) => git.git(project.path, "check-ignore", "-q", file).then(() => true, () => false);
      if (!(await isIgnored(ENV_FILE))) throw new Error(`${ENV_FILE} is not gitignored; refusing to commit anything until it is.`);
      const tracked: string[] = [];
      for (const file of changed) if (!(await isIgnored(file))) tracked.push(file);
      if (tracked.length) {
        await git.git(project.path, "add", "--", ...tracked);
        await git.git(project.path, "commit", "-q", "-m", `meadow: declare environment variables in ${tracked.join(", ")}`, "--", ...tracked);
      }
    } catch (error) {
      this.emit(state, "guard", "Couldn't prepare the environment files", (error as Error).message.slice(0, 500));
    }
    const missing = missingEnv(project.path, plan);
    const file = path.join(project.path, ENV_FILE);
    if (!missing.length) {
      this.emit(state, "message", "Environment variables ready", `${plan.env.required.length} required variable${plan.env.required.length === 1 ? "" : "s"} set in ${ENV_FILE}.`);
      return "ok";
    }
    const names = missing.map(item => item.name).join(", ");
    if (state.envOverride) {
      state.hint = [state.hint, `These environment variables are still empty in ${ENV_FILE}: ${names}. Build so the app still starts without them and shows a clear "not configured" message where they're needed; tests must not need the real values.`].filter(Boolean).join("\n");
      this.emit(state, "message", `Building without ${names}`, "The app will show a clear message where these are needed until you fill them in.");
      return "ok";
    }
    const list = missing.map(item => `- ${item.name}${item.hint ? ` — ${item.hint}` : ""}`).join("\n");
    this.emit(state, "setup", `${missing.length} environment variable${missing.length === 1 ? "" : "s"} needed`, `Open ${file} and fill in:\n${list}\n\nThe file is gitignored and only readable by you. Meadow checks that each value is set but never reads it into logs, prompts or chat.`, { payload: { service: "env", env: missing.map(item => item.name), ok: false } });
    this.park(state, null, "waiting", `Env: fill in ${names} in ${ENV_FILE}, then resume.`);
    return "parked";
  }

  private park(state: Active, phase: PhaseRow | null, status: "paused" | "waiting" | "blocked", note: string) {
    if (phase && status === "paused" && !["passed", "skipped", "pending"].includes(phase.status)) this.setPhase(phase, { status: "paused" });
    if (state.deferPark) {
      state.pendingPark ??= { phase, status, note };
      return status;
    }
    getDb().update("executions", state.executionId, { status, note });
    this.active.delete(state.projectId);
    this.emit(state, "control", status === "paused" ? "Run paused" : status === "waiting" ? "Waiting to continue" : "Run blocked", note, { phaseId: phase?.id ?? null, payload: { status } });
    return status;
  }

  private async prepare(state: Active, project: ProjectRow, plan: Plan, phase: PlanPhase, row: PhaseRow, wt?: Worktree): Promise<{ baseSha: string; resumed: boolean }> {
    this.setPhase(row, { status: "preparing", started_at: row.started_at ?? now() });
    if (wt) {
      const baseSha = (await git.git(wt.mainPath, "merge-base", project.base_branch, row.branch!)).trim();
      return { baseSha, resumed: row.attempts > 0 };
    }
    const branchName = row.branch ?? phaseBranch(phase);
    if (row.branch) for (const tree of await git.worktrees(project.path)) if (tree.branch === row.branch) await git.removeWorktree(project.path, tree.path);
    const current = await git.currentBranch(project.path);
    if (row.branch && (await git.branchExists(project.path, row.branch))) {
      if (current !== row.branch) {
        if (!(await git.isClean(project.path))) throw new Error(`Uncommitted changes on ${current}; cannot switch to ${row.branch}.`);
        await git.checkout(project.path, row.branch);
      }
      const baseSha = (await git.git(project.path, "merge-base", project.base_branch, row.branch)).trim();
      return { baseSha, resumed: row.attempts > 0 };
    }
    if (current !== project.base_branch) {
      if (!(await git.isClean(project.path))) throw new Error(`The project is on ${current} with uncommitted changes. Roll back or commit them first.`);
      await git.checkout(project.path, project.base_branch);
    }
    if (!(await git.isClean(project.path))) {
      throw new Error(`The working tree on ${project.base_branch} has uncommitted changes (${(await git.status(project.path)).slice(0, 5).map(entry => entry.path).join(", ")}). Commit or discard them, then resume.`);
    }
    if (state.engine.writeRules) {
      state.engine.writeRules(project.path, rulesFileContent(plan, projectRules(project), project.path));
      await git.commitAll(project.path, "meadow: update engine rules");
    }
    const baseSha = await git.headSha(project.path);
    await git.checkoutNewBranch(project.path, branchName);
    this.setPhase(row, { branch: branchName });
    return { baseSha, resumed: false };
  }

  private budgetExceeded(state: Active, row: PhaseRow, phaseStarted: number): string | null {
    if (state.budgetOverride) return null;
    const config = loadConfig().budget;
    const phaseTokens = getDb().get<{ t: number }>("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS t FROM runs WHERE phase_id = ? AND execution_id = ?", row.id, state.executionId)!.t;
    if (phaseTokens > config.phaseTokens) return `Budget: phase used ${phaseTokens.toLocaleString()} tokens (cap ${config.phaseTokens.toLocaleString()}).`;
    const today = new Date().toISOString().slice(0, 10);
    const dailyTokens = getDb().get<{ t: number }>("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS t FROM runs WHERE started_at >= ?", today)!.t;
    if (dailyTokens > config.dailyTokens) return `Budget: ${dailyTokens.toLocaleString()} tokens used today (cap ${config.dailyTokens.toLocaleString()}).`;
    const elapsed = (Date.now() - phaseStarted) / 1000;
    if (elapsed > config.phaseWallClockS) return `Budget: phase has run for ${Math.round(elapsed / 60)} minutes (cap ${Math.round(config.phaseWallClockS / 60)}).`;
    return null;
  }

  private async runEngine(state: Active, project: ProjectRow, row: PhaseRow, prompt: string, kind: "initial" | "fix"): Promise<{ ok: boolean; reason: string; report: string; filesTouched: number; forbidden: Array<Verdict & { command: string }>; guardNote: string }> {
    const config = loadConfig();
    const guardFiles = await writeEngineGuards(project.path, project.id).catch(error => ({ brokerAvailable: false, notes: [`Couldn't write the engine's guardrail files: ${(error as Error).message}`] }));
    for (const note of guardFiles.notes) this.emit(state, "guard", "Engine guardrails", note, { phaseId: row.id });
    const commands: string[] = [];
    const mcpCalls: string[] = [];
    const startedAt = now();
    const previousSession = getDb().get<{ session_id: string | null }>("SELECT session_id FROM runs WHERE phase_id = ? AND engine = ? AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1", row.id, state.engine.name)?.session_id ?? undefined;
    const runId = getDb().insert("runs", { execution_id: state.executionId, phase_id: row.id, kind, engine: state.engine.name, status: "running", prompt, started_at: now() });
    const release = await this.engineSlot.acquire();
    if (state.stopRequested) {
      release();
      getDb().update("runs", runId, { status: "cancelled", finished_at: now(), exit_reason: "cancelled" });
      return { ok: false, reason: "cancelled", report: "", filesTouched: 0, forbidden: [], guardNote: "" };
    }
    const runKey = `run-${runId}`;
    state.engineRunKeys.add(runKey);
    let ok = false;
    let reason = "crashed";
    let report = "";
    let filesTouched = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    let sessionId: string | null = null;
    let specificReason: string | null = null;
    try {
      const engineEnv = minimalEnv({ CURSOR_API_KEY: getSecret("CURSOR_API_KEY"), ANTHROPIC_API_KEY: config.engine.claudeUseFreeLlmApi ? undefined : getSecret("ANTHROPIC_API_KEY") });
      const stream = state.engine.run({
        runId: runKey,
        prompt,
        cwd: project.path,
        readonly: false,
        timeoutS: config.engine.runTimeoutS,
        noOutputTimeoutS: config.engine.noOutputTimeoutS,
        env: engineEnv,
        model: engineModel(state.engine.name),
        sessionId: kind === "fix" && state.engine.supportsResume ? previousSession : undefined,
      });
      for await (const event of stream) {
        this.recordEngineEvent(state, runId, row.id, event);
        if (event.sessionId) sessionId = event.sessionId;
        if (event.type === "file_edit") filesTouched += 1;
        if (event.type === "command_run") commands.push(event.title);
        if (event.type === "tool_call" && event.title.startsWith("MCP ")) mcpCalls.push(event.title.slice(4));
        if (event.type === "usage" && event.usage) {
          tokensIn += event.usage.tokensIn;
          tokensOut += event.usage.tokensOut;
          cost += event.usage.costUsd ?? 0;
        }
        if (event.type === "message" && event.detail) report = event.detail;
        if (event.type === "error" && event.reason && SPECIFIC_FAILURES.has(event.reason)) specificReason = event.reason;
        if (event.type === "done") {
          ok = Boolean(event.ok);
          reason = event.reason ?? (ok ? "completed" : "engine_error");
          if (event.detail) report = event.detail;
        }
      }
      if (!ok && specificReason && !SPECIFIC_FAILURES.has(reason) && reason !== "cancelled") reason = specificReason;
    } finally {
      release();
      state.engineRunKeys.delete(runKey);
      getDb().update("runs", runId, { status: ok ? "completed" : state.stopRequested ? "cancelled" : "failed", exit_reason: reason, finished_at: now(), tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost, session_id: sessionId });
      getDb().run("UPDATE executions SET tokens = tokens + ?, cost_usd = cost_usd + ? WHERE id = ?", tokensIn + tokensOut, cost, state.executionId);
    }
    const forbidden: Array<Verdict & { command: string }> = [];
    const warnings: string[] = [];
    for (const command of commands) {
      const verdict = classifyCommand(command, project.path);
      audit({ projectId: project.id, agent: state.engine.name, user: "engine", tool: `shell: ${command.split(/\s+/)[0] ?? "command"}`, risk: verdict.level === "forbidden" ? "DESTRUCTIVE" : "HIGH_WRITE", args: { command }, approval: verdict.level === "allowed" ? "not_required" : "refused", result: "ok", durationMs: 0, detail: `${verdict.rule}: ${command}` });
      if (verdict.level === "forbidden") forbidden.push({ ...verdict, command });
      else if (verdict.level === "approval") warnings.push(`You ran \`${command.slice(0, 120)}\` directly. ${verdict.reason} Next time call the Meadow tool request_system_action instead.`);
    }
    const brokerUsed = new Map<string, number>();
    const brokerApprovals = (tool: string) => getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE project_id = ? AND tool = ? AND result = 'ok' AND ts >= ?", project.id, tool, startedAt)?.n ?? 0;
    for (const call of mcpCalls) {
      const verdict = classifyMcpCall(call, brokerApprovals, brokerUsed);
      audit({ projectId: project.id, agent: state.engine.name, user: "engine", tool: `mcp: ${call}`, risk: verdict.level === "forbidden" ? "DESTRUCTIVE" : verdict.rule === "mcp-brokered" ? "HIGH_WRITE" : "READ", args: { call }, approval: verdict.rule === "mcp-brokered" ? "approved" : verdict.level === "forbidden" ? "refused" : "not_required", result: "ok", durationMs: 0, detail: `${verdict.rule}: ${call}` });
      if (verdict.level === "forbidden") forbidden.push({ ...verdict, command: `MCP ${call}` });
    }
    const servers = [...new Set(mcpCalls.map(call => call.split(":")[0]))].filter(Boolean);
    if (servers.length && /unauthori[sz]ed|authenticat|sign ?in|log ?in|\b401\b|expired/i.test(report)) {
      const statuses = await engineMcpStatus(true).catch((): Record<string, string> => ({}));
      for (const server of servers.filter(name => statuses[name] === "needs_login")) {
        this.emit(state, "setup", `${server} sign-in expired`, `The engine lost access to ${server} during this phase. Sign in again, then Retry the phase.`, { phaseId: row.id, payload: { service: server, needsLogin: true, ok: false } });
      }
    }
    const restored = await checkEngineGuards(project.path, project.id).catch(() => null);
    const guardNote = [restored, ...new Set(warnings)].filter(Boolean).join("\n");
    if (guardNote) this.emit(state, "guard", "Guardrail notice", guardNote, { phaseId: row.id });
    return { ok, reason, report, filesTouched, forbidden, guardNote };
  }

  private recordEngineEvent(state: Active, runId: number, phaseId: number, event: EngineEvent) {
    if (event.type === "usage") return;
    // console_line: emit as a lightweight event for live streaming; never stored in the DB.
    if (event.type === "console_line") {
      this.emit(state, "console_line", event.title, "", { runId, phaseId });
      return;
    }
    this.emit(state, event.type, event.title, event.detail ?? "", { runId, phaseId, payload: event.reason ? { reason: event.reason } : undefined });
  }

  private async runPhase(state: Active, project: ProjectRow, plan: Plan, phase: PlanPhase, row: PhaseRow, ordered: PlanPhase[], wt?: Worktree): Promise<PhaseOutcome> {
    const config = loadConfig();
    const phaseNumber = ordered.indexOf(phase) + 1;
    let baseSha: string;
    let resumed: boolean;
    try {
      ({ baseSha, resumed } = await this.prepare(state, project, plan, phase, row, wt));
    } catch (error) {
      this.setPhase(row, { status: "blocked" });
      this.emit(state, "phase_blocked", `Phase ${phaseNumber} could not start: ${phase.name}`, (error as Error).message, { phaseId: row.id, payload: { phaseNumber, total: ordered.length, reason: "prepare", lastError: (error as Error).message } });
      this.park(state, row, "blocked", (error as Error).message);
      return "blocked";
    }
    this.emit(state, "phase_started", `Phase ${phaseNumber} of ${ordered.length}${resumed ? " resumed" : " started"}: ${phase.name}`, `${roleLabel(phase.agent)} · branch ${row.branch}${wt ? " · own worktree" : ""}`, { phaseId: row.id, payload: { phaseNumber, total: ordered.length, agent: phase.agent ?? "builder", parallel: Boolean(wt) } });

    const rows = phasesFor(row.plan_id);
    const previousSummaries = ordered.slice(0, ordered.indexOf(phase)).map(prev => rows.find(item => item.phase_key === prev.id)).filter(item => item?.summary).map(item => ({ name: item!.name, summary: item!.summary! }));
    const phaseStarted = Date.now();
    let attemptsThisRun = 0;
    let lastFailure: CheckOutcome | null = null;
    let lastSignature: string | null = null;
    let noChangeStreak = 0;
    let rateLimitHits = 0;
    let guardFeedback = "";
    let engineGuardNote = "";
    let engineReport = "";
    let impactText = "";
    const diagnoses: string[] = [];
    let supervisorHint: string | undefined;
    let releasePreview: (() => void) | null = null;
    let conflictRounds = 0;
    const parallelNote = wt ? `You are one of several agents working at the same time, each in its own git worktree. This worktree starts without installed dependencies: install them before running checks. Change only what your tasks need so your branch merges cleanly with the others.` : "";
    if (config.harness.preflightImpact) {
      try {
        const impact = preflightImpact(project.id, phase);
        if (impact) {
          impactText = impact.text;
          this.emit(state, "impact", `Impact of ${phase.name}: ${impact.report.impacted.length} affected (${impact.report.risk} risk)`, impact.report.reasons.join("; ") || "No dependents", { phaseId: row.id, payload: { risk: impact.report.risk, services: impact.report.services, apis: impact.report.apis.length, tables: impact.report.tables, tests: impact.report.tests.length, affected: impact.report.impacted.length } });
        }
      } catch {
        // No graph yet: the phase runs without an impact section.
      }
    }
    const isAcceptance = phase.id === ACCEPTANCE_KEY;
    const extraChecks = autoChecks(project.id, phase.checks);
    let e2e: AcceptanceResult | null = null;
    let preview: PreviewHandle | null = null;
    const needsPreview = Boolean(plan.preview && phase.checks.some(check => check.kind === "http" || check.kind === "e2e"));

    try {
      // Resuming a phase that already had attempts: verify what is on the branch before spending engine time.
      let skipEngine = resumed && !state.hint;
      while (true) {
        if (wt) {
          preview?.stop();
          preview = null;
          releasePreview?.();
          releasePreview = null;
        }
        if (state.stopRequested) {
          this.setPhase(row, { status: "stopped" });
          return "stopped";
        }
        if (state.pauseRequested) {
          this.park(state, row, "paused", `Paused during ${phase.name}.`);
          return "paused";
        }
        const overBudget = this.budgetExceeded(state, row, phaseStarted);
        if (overBudget) {
          this.park(state, row, "paused", overBudget);
          this.emit(state, "approval_requested", "Budget cap reached", `${overBudget} Resume to continue past the cap for this phase.`, { phaseId: row.id, payload: { budget: true } });
          return "paused";
        }

        if (!skipEngine) {
          attemptsThisRun += 1;
          this.setPhase(row, { status: lastFailure || guardFeedback ? "fixing" : "running", attempts: row.attempts + 1 });
          const context = [impactText, await promptContext(project.id, project.path, `${phase.name} ${phase.tasks.join(" ")}`)].filter(Boolean).join("\n\n");
          const brief = projectBrief(project.id, lastFailure ? 2500 : 6000, phase.id);
          const prompt = lastFailure
            ? compileFixPrompt({ plan, phase, projectPath: project.path, failing: { check: lastFailure.check, exitCode: lastFailure.exitCode, output: lastFailure.output }, hint: state.hint ?? undefined, supervisor: supervisorHint, guardFeedback: [guardFeedback, parallelNote].filter(Boolean).join("\n\n"), brief, attempt: { n: attemptsThisRun, max: config.harness.maxAttempts }, tailLines: lastFailure.check === E2E_CHECK ? 220 : undefined })
            : compilePhasePrompt({ plan, phase, projectPath: project.path, projectRules: projectRules(project), previousSummaries, context, brief, guardFeedback: [guardFeedback, state.hint ? `Hint from the user: ${state.hint}` : "", parallelNote].filter(Boolean).join("\n") });
          const hintUsed = state.hint;
          state.hint = null;
          supervisorHint = undefined;
          const result = await this.runEngine(state, project, row, prompt, lastFailure ? "fix" : "initial");
          engineReport = result.report || engineReport;
          if (state.stopRequested || result.reason === "cancelled") {
            this.setPhase(row, { status: "stopped" });
            return "stopped";
          }
          if (result.reason === "rate_limited") {
            attemptsThisRun -= 1;
            this.setPhase(row, { attempts: Math.max(0, row.attempts - 1) });
            state.hint = hintUsed;
            const waits = rateLimitWaits();
            if (rateLimitHits >= waits.length) {
              this.park(state, row, "paused", `${state.engine.label} is still rate limited after ${waits.length} waits. Resume when your quota resets; no attempts were used.`);
              return "paused";
            }
            const waitS = waits[rateLimitHits++];
            this.emit(state, "guard", `${state.engine.label} is rate limited; waiting ${waitS}s`, "This does not count as an attempt. Meadow retries automatically, and pausing or stopping still works while it waits.", { phaseId: row.id, payload: { rateLimited: true, waitS } });
            await this.waitInterruptibly(state, waitS * 1000);
            continue;
          }
          rateLimitHits = 0;
          engineGuardNote = result.guardNote;
          if (result.forbidden.length) {
            const first = result.forbidden[0];
            return this.block(state, row, phase, phaseNumber, ordered.length, `because the engine ran a forbidden command (${first.rule})`, { check: { kind: "cmd", cmd: first.command }, label: first.command, passed: false, exitCode: null, output: `${first.reason}\nCommand: ${first.command}\nReview the branch before retrying; roll back if anything looks wrong.`, durationMs: 0 });
          }
          if (["missing_binary", "auth", "model_unavailable"].includes(result.reason)) {
            const model = engineModel(state.engine.name);
            const why =
              result.reason === "auth"
                ? `is not logged in. ${engineLoginHint(state.engine.name)}, then click Retry`
                : result.reason === "missing_binary"
                  ? "is not installed (run `meadow doctor` for the install command)"
                  : `can't use model ${model ? `"${model}"` : "(its default)"}; choose a model your account or gateway serves in Runtime settings`;
            return this.block(state, row, phase, phaseNumber, ordered.length, `because ${state.engine.label} ${why}`, null);
          }
          if (result.filesTouched === 0 && attemptsThisRun > 1) noChangeStreak += 1;
          else noChangeStreak = 0;
        }
        skipEngine = false;

        const guards = await runGuards(project.path, baseSha);
        guardFeedback = [guards.feedback, engineGuardNote].filter(Boolean).join("\n\n");
        if (guards.reverted.length || guards.escaped.length) this.emit(state, "guard", "Guard reverted out-of-scope edits", [...guards.escaped, ...guards.reverted].join(", "), { phaseId: row.id });
        if (guards.deletions.length > config.harness.massDeleteThreshold) {
          const approval = requestApproval({ projectId: project.id, kind: "mass_delete", title: `Delete ${guards.deletions.length} files?`, detail: `Phase "${phase.name}" deleted ${guards.deletions.length} files, e.g. ${guards.deletions.slice(0, 8).join(", ")}.`, risk: "high" });
          this.setPhase(row, { status: "paused" });
          const approved = await Promise.race([approval.decision, new Promise<boolean>(resolve => state.abort.signal.addEventListener("abort", () => resolve(false), { once: true }))]);
          if (state.stopRequested) return "stopped";
          if (!approved) {
            await git.revertPaths(project.path, baseSha, guards.deletions);
            guardFeedback += `\n\nThe user denied deleting ${guards.deletions.length} files; they were restored. Do not delete files unless a task requires it.`;
          }
        }

        if (wt && !releasePreview) releasePreview = await state.previewLock.acquire();
        this.setPhase(row, { status: "verifying" });
        if (needsPreview && !preview) {
          try {
            preview = await startPreview(plan.preview!, project.path);
          } catch (error) {
            this.emit(state, "error", "Preview server did not start", tail((error as Error).message, 30), { phaseId: row.id });
          }
        }
        const outcomes = await verify([...phase.checks, ...extraChecks, ...(conflictRounds ? [CONFLICT_CHECK] : [])], {
          cwd: project.path,
          previewUrl: preview?.url ?? null,
          phaseId: row.id,
          runId: null,
          projectId: project.id,
          signal: state.abort.signal,
          onResult: outcome => this.emit(state, "check_result", `${outcome.passed ? "✓" : "✗"} ${outcome.label}`, outcome.passed ? `passed in ${(outcome.durationMs / 1000).toFixed(1)}s` : tail(outcome.output, 12), { phaseId: row.id, payload: { passed: outcome.passed, exitCode: outcome.exitCode } }),
        });
        if (state.stopRequested) {
          this.setPhase(row, { status: "stopped" });
          return "stopped";
        }
        let failing = outcomes.find(outcome => !outcome.passed) ?? null;
        e2e = null;
        if (isAcceptance && !failing && !guards.blocking) {
          preview?.stop();
          preview = null;
          e2e = await runAcceptance({ projectPath: project.path, projectId: project.id, phaseId: row.id, plan, baseSha, folder: `e2e-${row.id}-${row.attempts}`, onProgress: (title, detail) => this.emit(state, "message", title, detail, { phaseId: row.id }) });
          if (state.stopRequested) {
            this.setPhase(row, { status: "stopped" });
            return "stopped";
          }
          const result = e2e.outcome;
          getDb().insert("checks", { phase_id: row.id, run_id: null, label: result.label, command: result.label, exit_code: result.exitCode, passed: result.passed ? 1 : 0, output_tail: tail(result.output, 80), duration_ms: result.durationMs, ts: now() });
          for (const item of e2e.results) this.emit(state, "check_result", `${item.passed ? "✓" : "✗"} ${item.name}`, item.passed ? "passed in the browser" : item.failure ?? "failed", { phaseId: row.id, payload: { passed: item.passed, exitCode: item.passed ? 0 : 1 } });
          this.emit(state, "check_result", `${result.passed ? "✓" : "✗"} ${result.label}`, result.passed ? result.output : tail(result.output, 12), { phaseId: row.id, payload: { passed: result.passed, exitCode: result.exitCode } });
          outcomes.push(result);
          if (!result.passed) failing = result;
        }

        if (!failing && !guards.blocking && !isAcceptance && uiGateApplies(plan, phase)) {
          const touched = (await git.diffStat(project.path, baseSha)).map(file => file.path);
          if (touchesUi(touched)) {
            if (!preview) {
              preview = await startPreview(plan.preview!, project.path).catch(error => {
                this.emit(state, "error", "Design review skipped: the preview server did not start", tail((error as Error).message, 30), { phaseId: row.id });
                return null;
              });
            }
            if (preview) {
              this.emit(state, "message", "Reviewing the design in a browser", `Desktop and phone width on ${plan.preview!.routes.slice(0, 3).join(", ")}`, { phaseId: row.id });
              const review = await runDesignReview({ baseUrl: preview.url, routes: plan.preview!.routes });
              getDb().insert("checks", { phase_id: row.id, run_id: null, label: review.label, command: review.label, exit_code: review.exitCode, passed: review.passed ? 1 : 0, output_tail: tail(review.output, 80), duration_ms: review.durationMs, ts: now() });
              this.emit(state, "check_result", `${review.passed ? "✓" : "✗"} ${review.label}`, review.passed ? review.output : tail(review.output, 12), { phaseId: row.id, payload: { passed: review.passed, exitCode: review.exitCode } });
              outcomes.push(review);
              if (!review.passed) failing = review;
            }
          }
        }

        if (!failing && !guards.blocking) {
          preview?.stop();
          preview = null;
          const member: TeamMember = { phase: phase.name, agent: phase.agent ?? "builder", attempts: Math.max(1, attemptsThisRun), status: "passed", notes: diagnoses };
          const merged = await this.pass(state, project, plan, phase, row, phaseNumber, ordered.length, baseSha, outcomes, guards.dependencyChanges, engineReport, e2e, { member, wt });
          if (merged === true) {
            state.team.push(member);
            return "passed";
          }
          const files = merged.conflicts.slice(0, 10).join(", ");
          if (!wt || conflictRounds >= 2) {
            const kept = wt ? await this.abandonWorktree(row, wt) : row.branch;
            return this.block(state, row, phase, phaseNumber, ordered.length, "(its branch conflicts with work merged by another agent)", null, [], `Conflicting files: ${files}\nThe attempt was kept on ${kept}. Retry rebuilds this phase on top of the merged code.`);
          }
          // Like a developer would: bring main into this branch and resolve the conflicts, then merge again.
          conflictRounds += 1;
          baseSha = await git.headSha(wt.mainPath);
          await git.git(wt.dir, "merge", "--no-commit", "--no-ff", project.base_branch).catch(() => undefined);
          this.emit(state, "message", `${roleLabel(phase.agent)} is resolving a merge conflict with another agent`, `Conflicting files: ${files}`, { phaseId: row.id, payload: { conflicts: merged.conflicts } });
          lastFailure = { check: CONFLICT_CHECK, label: `Merge ${project.base_branch} into this branch`, passed: false, exitCode: 1, output: `Another agent's work was merged into ${project.base_branch} first and conflicts with this branch in: ${files}.\nThat merge is now in progress in this worktree. Resolve every conflict marker (<<<<<<<, =======, >>>>>>>) so both agents' features keep working, keep the other agent's changes, then run the checks again. Don't abort the merge or reset the branch.`, durationMs: 0 };
          guardFeedback = "";
          continue;
        }

        lastFailure = failing ?? lastFailure;
        if (failing && !isAcceptance && plan.preview && preview && project.screenshots && config.screenshots.enabled) {
          await this.screenshots(state, project, plan, row, `phase-${phase.id}-failure`, ["/"], ["desktop"]);
        }
        const signature = failing ? (failing.check === E2E_CHECK && e2e ? `e2e:${e2e.signature}` : `${failing.label}:${tail(failing.output, 15).replace(/\d+(\.\d+)?m?s\b/g, "")}`) : `guards:${guardFeedback}`;
        const sameError = signature === lastSignature;
        lastSignature = signature;
        const exhausted = attemptsThisRun >= config.harness.maxAttempts;
        const stuck = (sameError && attemptsThisRun >= 2) || noChangeStreak >= 2;
        const failShots = () => (e2e ? e2e.results.filter(item => !item.passed).flatMap(item => item.screenshots.slice(-1).map(shot => shot.id)) : []);
        const verdict = failing ? await this.supervise(state, project, plan, phase, row, failing, { n: Math.max(1, attemptsThisRun), max: config.harness.maxAttempts }, diagnoses) : null;
        if (state.stopRequested) {
          this.setPhase(row, { status: "stopped" });
          return "stopped";
        }
        const supervisorNote = verdict ? `Supervisor: ${verdict.diagnosis}` : "";
        if (verdict?.action === "escalate" && attemptsThisRun >= 2) {
          return this.block(state, row, phase, phaseNumber, ordered.length, "(the supervisor says it needs you)", failing, failShots(), supervisorNote);
        }
        if (exhausted || stuck) {
          const why = exhausted ? `after ${attemptsThisRun} attempt${attemptsThisRun === 1 ? "" : "s"}` : sameError ? "(same error twice in a row)" : "(no file changes across two fix attempts)";
          return this.block(state, row, phase, phaseNumber, ordered.length, why, failing, failShots(), supervisorNote);
        }
        supervisorHint = verdict ? [verdict.diagnosis, verdict.hint].filter(Boolean).join("\n") : undefined;
        this.emit(state, "message", attemptsThisRun === 0 ? "The branch does not pass its checks yet; starting a fix attempt" : `Attempt ${attemptsThisRun} failed; starting fix attempt ${attemptsThisRun + 1}`, failing ? `${failing.label} exited ${failing.exitCode ?? "without a code"}` : guardFeedback.split("\n")[0], { phaseId: row.id });
      }
    } finally {
      preview?.stop();
      releasePreview?.();
    }
  }

  /** Gives up on a parallel branch: its work is kept under failed/ and the phase starts fresh on retry. */
  private async abandonWorktree(row: PhaseRow, wt: Worktree): Promise<string> {
    await git.git(wt.dir, "merge", "--abort").catch(() => undefined);
    await git.removeWorktree(wt.mainPath, wt.dir);
    const kept = `failed/${row.branch!.replace(/^meadow\//, "")}-${Date.now()}`;
    await git.git(wt.mainPath, "branch", "-m", row.branch!, kept).catch(() => undefined);
    this.setPhase(row, { branch: null, attempts: 0 });
    return kept;
  }

  /** Asks the supervisor model to diagnose a failed attempt and posts its verdict. Null when no supervisor is reachable. */
  private async supervise(state: Active, project: ProjectRow, plan: Plan, phase: PlanPhase, row: PhaseRow, failing: CheckOutcome, attempt: { n: number; max: number }, diagnoses: string[]): Promise<SupervisorVerdict | null> {
    if (!supervisorAvailable()) return null;
    const verdict = await diagnoseFailure({ plan, phase, projectPath: project.path, failing: { label: failing.label, exitCode: failing.exitCode, output: failing.output }, attempt, previous: diagnoses, signal: state.abort.signal }).catch(() => null);
    if (!verdict) return null;
    diagnoses.push(verdict.diagnosis || verdict.hint.split("\n")[0]);
    this.emit(state, "supervisor", `Supervisor on ${phase.name}: ${verdict.action === "escalate" ? "needs you" : "retrying with a diagnosis"}`, [verdict.diagnosis, verdict.hint ? `Next step for the ${roleLabel(phase.agent).toLowerCase()}:\n${verdict.hint}` : ""].filter(Boolean).join("\n\n"), { phaseId: row.id, payload: { action: verdict.action, by: verdict.by, agent: phase.agent ?? "builder", attempt: attempt.n } });
    return verdict;
  }

  private block(state: Active, row: PhaseRow, phase: PlanPhase, phaseNumber: number, total: number, why: string, failing: CheckOutcome | null, screenshotIds: number[] = [], note = ""): PhaseOutcome {
    this.setPhase(row, { status: "blocked" });
    const lastError = failing ? (failing.check === E2E_CHECK ? failing.output.split("\n").filter(line => /^(##|Failed at|Reason:)/.test(line)).slice(0, 12).join("\n") || tail(failing.output, 6) : tail(failing.output, 6)) : note || why;
    const detail = [failing ? `Failing: ${failing.label} (exit ${failing.exitCode ?? "n/a"})\n${lastError}` : "", note || (failing ? "" : why)].filter(Boolean).join("\n\n");
    this.emit(state, "phase_blocked", `Phase ${phaseNumber} is stuck ${why}: ${phase.name}`, detail, { phaseId: row.id, payload: { phaseNumber, total, failing: failing?.label ?? null, exitCode: failing?.exitCode ?? null, lastError, attempts: row.attempts, screenshotIds, agent: phase.agent ?? "builder" } });
    this.park(state, row, "blocked", `Phase ${phaseNumber} blocked ${why}.`);
    return "blocked";
  }

  private async screenshots(state: Active, project: ProjectRow, plan: Plan, row: PhaseRow, folder: string, routes?: string[], viewports?: Array<"desktop" | "mobile">) {
    let ownPreview: PreviewHandle | null = null;
    try {
      ownPreview = await startPreview(plan.preview!, project.path).catch(() => null);
      const baseUrl = plan.preview!.url;
      const { shots, skipped } = await captureRoutes({ baseUrl, routes: routes ?? plan.preview!.routes, projectPath: project.path, projectId: project.id, phaseId: row.id, folder, viewports });
      for (const shot of shots) this.emit(state, "screenshot", `Screenshot ${shot.label}`, shot.path, { phaseId: row.id, payload: { screenshotId: shot.id, route: shot.route, viewport: shot.viewport } });
      for (const reason of skipped) this.emit(state, "message", "Screenshot skipped", reason, { phaseId: row.id });
      return shots;
    } catch (error) {
      this.emit(state, "error", "Screenshot capture failed", (error as Error).message, { phaseId: row.id });
      return [];
    } finally {
      ownPreview?.stop();
    }
  }

  private async pass(state: Active, project: ProjectRow, plan: Plan, phase: PlanPhase, row: PhaseRow, phaseNumber: number, total: number, baseSha: string, outcomes: CheckOutcome[], dependencyChanges: string[], engineReport: string, e2e: AcceptanceResult | null = null, team: { member?: TeamMember; wt?: Worktree } = {}): Promise<true | { conflicts: string[] }> {
    const diff = await git.diffStat(project.path, baseSha);
    const config = loadConfig();
    let shotIds: number[] = [];
    if (!e2e && plan.preview && project.screenshots && config.screenshots.enabled) {
      shotIds = (await this.screenshots(state, project, plan, row, `phase-${phase.id}`)).map(shot => shot.id);
    }
    const summary = await summarizePhase(phase, diff, outcomes, engineReport);
    const message = `meadow: phase ${phase.id} passed: ${phase.name}\n\nChecks:\n${outcomes.map(outcome => `- ${outcome.label}: ok`).join("\n")}\n\n${summary}`;
    let sha = (await git.commitAll(project.path, message)) ?? (await git.headSha(project.path));
    const wt = team.wt;
    const main: ProjectRow = wt ? { ...project, path: wt.mainPath } : project;
    if (wt) {
      const release = await state.mergeLock.acquire();
      try {
        const merged = await git.mergeInto(wt.mainPath, project.base_branch, row.branch!, `meadow: merge phase ${phase.id}: ${phase.name}`);
        if (!merged.ok) return { conflicts: merged.conflicts };
        sha = merged.sha;
      } finally {
        release();
      }
      await git.removeWorktree(wt.mainPath, wt.dir);
    } else {
      await git.fastForward(project.path, project.base_branch, row.branch!);
    }
    this.setPhase(row, { status: "passed", summary, commit_sha: sha, finished_at: now() });
    const additions = diff.reduce((sum, file) => sum + file.additions, 0);
    const deletions = diff.reduce((sum, file) => sum + file.deletions, 0);
    this.emit(state, "phase_passed", `Phase ${phaseNumber} of ${total} passed: ${phase.name}`, summary, {
      phaseId: row.id,
      payload: { phaseNumber, total, checks: outcomes.map(outcome => outcome.label), files: diff.length, additions, deletions, dependencyChanges, screenshotIds: shotIds, commit: sha.slice(0, 10), ...(team.member ? { team: team.member } : {}), parallel: Boolean(wt) },
    });
    project = main;
    const push = await pushBase(project).catch(error => ({ pushed: false, detail: `Push failed: ${(error as Error).message}` }));
    if (push.detail) this.emit(state, push.pushed ? "message" : "guard", push.pushed ? "Pushed to GitHub" : "GitHub push skipped", push.detail, { phaseId: row.id });
    if (e2e) {
      state.lastE2e = { results: e2e.results, runHow: e2e.runHow, url: e2e.url };
      e2e.results.forEach((result, index) => {
        for (const shot of result.screenshots) this.emit(state, "screenshot", `Final screenshot ${result.name} · ${shot.label}`, shot.path, { phaseId: row.id, payload: { screenshotId: shot.id, final: true, e2e: true } });
        this.emit(state, "check_result", `Test case ${index + 1} of ${e2e.results.length}: ${result.name}`, result.pageText.replace(/\s+/g, " ").slice(0, 300), { phaseId: row.id, payload: { passed: true, exitCode: 0, e2eCase: true, case: result.name, index: index + 1, total: e2e.results.length, screenshotIds: result.screenshots.map(shot => shot.id) } });
      });
    }
    indexMemory(project.id, `phase ${phase.id} summary`, `${phase.name}: ${summary}`).catch(() => undefined);
    liveGraph
      .refresh(project.id, `phase ${phase.id} passed`, { forceGraph: true })
      .then(update => (update ? undefined : indexProject(project.id, project.path).then(() => liveGraph.markIndexed(project.id))))
      .catch(() => undefined);
    return true;
  }

  /** Generate .meadow/docs/ (PRD, Design System, Architecture, Agents Guide) from the plan after completion. */
  private async generateDocs(state: Active, project: ProjectRow, plan: Plan) {
    try {
      this.emit(state, "message", "Generating project docs", "Writing PRD, Design System, Architecture and Agents Guide to .meadow/docs/");
      const planPath = path.join(project.path, "PLAN.md");
      const planMd = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf8") : plan.body;
      const result = await generateProjectDocs(project.path, plan, planMd);
      const detail = [
        result.generated.length ? `Generated: ${result.generated.join(", ")}` : "",
        result.skipped.length ? `Skipped (LLM error): ${result.skipped.join(", ")}` : "",
      ].filter(Boolean).join(" · ");
      if (result.generated.length) {
        // Commit the docs so they travel with the code on the next push.
        await git.commitAll(project.path, `meadow: generate ${result.dir}`).catch(() => undefined);
        const push = await pushBase(project).catch(error => ({ pushed: false, detail: `Push failed: ${(error as Error).message}` }));
        this.emit(state, "message", "Project docs ready", `${detail}${push.pushed ? ` · Pushed to GitHub` : ""}`);
      } else {
        this.emit(state, "message", "Project docs skipped", detail || "LLM unavailable");
      }
    } catch (error) {
      // Docs generation is best-effort; never block completion.
      this.emit(state, "message", "Project docs skipped", (error as Error).message.slice(0, 300));
    }
  }

  async shutdown() {
    for (const projectId of Array.from(this.active.keys())) await this.stop(projectId);
  }
}

export const harness = new Harness();
