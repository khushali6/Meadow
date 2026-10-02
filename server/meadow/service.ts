import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { listApprovals } from "./core/approvals";
import { getDb } from "./core/db";
import { recentEvents } from "./core/events";
import * as git from "./core/git";
import { harness, type ExecutionRow } from "./harness/runner";
import { checkLabel, executionOrder, parsePlan, type Plan } from "./planning/format";
import { activePlan, getProject, latestPlan, listProjects, phasesFor, planVersions, type PhaseRow, type ProjectRow } from "./projects";

export function planSummaryText(plan: Plan, version?: number): string {
  const lines = [`Plan${version ? ` v${version}` : ""} for ${plan.project}`, plan.goal, ""];
  executionOrder(plan.phases).forEach((phase, i) => {
    lines.push(`${i + 1}. ${phase.name}`);
    lines.push(`   checks: ${phase.checks.map(checkLabel).join(" · ")}`);
  });
  if (plan.preview) lines.push("", `Preview: ${plan.preview.command} → ${plan.preview.url}`);
  return lines.join("\n");
}

function orderedPhases(projectId: number): Array<PhaseRow & { checks: string[]; tasks: string[]; doneWhen: string; dependsOn: string[] }> {
  const row = activePlan(projectId);
  if (!row) return [];
  const parsed = parsePlan(row.raw_md);
  if (!parsed.ok) return [];
  const rows = phasesFor(row.id);
  return executionOrder(parsed.plan.phases).map(phase => {
    const phaseRow = rows.find(item => item.phase_key === phase.id)!;
    return { ...phaseRow, checks: phase.checks.map(checkLabel), tasks: phase.tasks, doneWhen: phase.doneWhen, dependsOn: phase.dependsOn };
  });
}

export function statusText(projectId: number): string {
  const project = getProject(projectId);
  const execution = harness.latestExecution(projectId);
  const phases = orderedPhases(projectId);
  if (!phases.length) return `${project.name}: no approved plan yet.`;
  const passed = phases.filter(phase => phase.status === "passed").length;
  const current = phases.find(phase => !["passed", "skipped"].includes(phase.status));
  const parts = [`${project.name}: ${passed}/${phases.length} phases passed.`];
  if (execution) parts.push(`Run is ${harness.isActive(projectId) ? "running" : execution.status}${execution.note ? ` (${execution.note})` : ""}.`);
  if (current) parts.push(`Current: ${current.name} — ${current.status}, ${current.attempts} attempt${current.attempts === 1 ? "" : "s"}.`);
  if (execution?.tokens) parts.push(`Tokens used this run: ${execution.tokens.toLocaleString()}.`);
  return parts.join(" ");
}

export type ProjectSummary = ProjectRow & { status: string; currentPhase: number; phaseCount: number; passed: number };

function projectSummary(project: ProjectRow): ProjectSummary {
  const phases = orderedPhases(project.id);
  const execution = harness.latestExecution(project.id);
  const passed = phases.filter(phase => phase.status === "passed").length;
  const currentIndex = phases.findIndex(phase => !["passed", "skipped"].includes(phase.status));
  const status = harness.isActive(project.id) ? "running" : execution?.status ?? (latestPlan(project.id) ? (activePlan(project.id) ? "ready" : "draft") : "new");
  return { ...project, status, currentPhase: currentIndex < 0 ? phases.length : currentIndex + 1, phaseCount: phases.length, passed };
}

export function projectsOverview() {
  return listProjects().map(projectSummary);
}

export function projectDetail(projectId: number) {
  const project = getProject(projectId);
  const execution: (ExecutionRow & { active: boolean }) | null = (() => {
    const latest = harness.latestExecution(projectId);
    return latest ? { ...latest, active: harness.isActive(projectId) } : null;
  })();
  const plan = latestPlan(projectId);
  const approved = activePlan(projectId);
  const pendingApprovals = listApprovals(50).filter(item => item.status === "pending" && (item.project_id === projectId || item.project_id === null));
  return {
    project: projectSummary(project),
    execution,
    phases: orderedPhases(projectId),
    events: recentEvents(projectId, 400),
    latestPlan: plan ? { id: plan.id, version: plan.version, status: plan.status, raw: plan.raw_md, spec: plan.spec_md, source: plan.source } : null,
    approvedPlanId: approved?.id ?? null,
    pendingApprovals: pendingApprovals.length,
    budget: { phaseTokens: loadConfig().budget.phaseTokens, dailyTokens: loadConfig().budget.dailyTokens },
  };
}

export function phaseEvidence(phaseId: number) {
  const db = getDb();
  const checks = db.all<{ id: number; label: string; exit_code: number | null; passed: number; output_tail: string; duration_ms: number; ts: string }>("SELECT id, label, exit_code, passed, output_tail, duration_ms, ts FROM checks WHERE phase_id = ? ORDER BY id DESC LIMIT 60", phaseId);
  const runs = db.all<{ id: number; kind: string; engine: string; status: string; exit_reason: string | null; prompt: string; started_at: string; finished_at: string | null; tokens_in: number; tokens_out: number }>("SELECT id, kind, engine, status, exit_reason, prompt, started_at, finished_at, tokens_in, tokens_out FROM runs WHERE phase_id = ? ORDER BY id DESC LIMIT 20", phaseId);
  const screenshots = db.all<{ id: number; label: string; viewport: string; ts: string }>("SELECT id, label, viewport, ts FROM screenshots WHERE phase_id = ? ORDER BY id DESC LIMIT 24", phaseId);
  return { checks, runs, screenshots };
}

export async function phaseDiff(phaseId: number) {
  const phase = getDb().get<PhaseRow & { project_id: number }>("SELECT phases.*, plans.project_id FROM phases JOIN plans ON plans.id = phases.plan_id WHERE phases.id = ?", phaseId);
  if (!phase) throw new Error("Phase not found");
  const project = getProject(phase.project_id);
  try {
    if (phase.commit_sha) {
      const files = await git.diffStat(project.path, `${phase.commit_sha}~1`).catch(() => []);
      const text = await git.git(project.path, "show", "--no-color", "--format=", phase.commit_sha).catch(() => "");
      return { files, text: text.slice(0, 200_000) };
    }
    if (phase.branch && (await git.currentBranch(project.path)) === phase.branch) {
      const base = (await git.git(project.path, "merge-base", project.base_branch, phase.branch)).trim();
      return { files: await git.diffStat(project.path, base), text: await git.diffText(project.path, base) };
    }
  } catch {
    // Fall through to an empty diff.
  }
  return { files: [], text: "" };
}

export function screenshotFile(id: number): string | null {
  const row = getDb().get<{ path: string; project_id: number }>("SELECT path, project_id FROM screenshots WHERE id = ?", id);
  if (!row) return null;
  const project = getProject(row.project_id);
  const resolved = path.resolve(row.path);
  if (!resolved.startsWith(path.join(project.path, ".meadow", "screenshots"))) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

export function notesFor(projectId: number | null) {
  return getDb().all<{ id: number; project_id: number | null; title: string; body: string; source: string; created_at: string }>(
    "SELECT * FROM notes WHERE project_id IS ? OR project_id IS NULL ORDER BY id DESC LIMIT 200",
    projectId,
  );
}

export function planHistory(projectId: number) {
  return planVersions(projectId).map(plan => ({ id: plan.id, version: plan.version, status: plan.status, source: plan.source, created_at: plan.created_at, raw: plan.raw_md }));
}

export function usageToday() {
  const today = new Date().toISOString().slice(0, 10);
  return getDb().get<{ tokens: number; cost: number; runs: number }>("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS runs FROM runs WHERE started_at >= ?", today)!;
}
