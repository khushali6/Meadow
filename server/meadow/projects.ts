import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { getDb, now } from "./core/db";
import { assertSelectableEngine, effectiveDefaultEngine, engineLabel, engineStatus } from "./engines/registry";
import { bus } from "./core/events";
import { commitAll, currentBranch, ensureRepo, isClean } from "./core/git";
import { confine, slugify, validProjectName } from "./core/paths";
import { meadowOverlapMessage, overlapsMeadow } from "./core/self";
import { parsePlan, type Plan } from "./planning/format";

export type ProjectRow = { id: number; name: string; path: string; engine: string; description: string; screenshots: number; base_branch: string; created_at: string; updated_at: string };
export type PlanRow = { id: number; project_id: number; version: number; raw_md: string; spec_md: string | null; source: string; status: "draft" | "approved" | "superseded"; created_at: string };
export type PhaseRow = { id: number; plan_id: number; idx: number; phase_key: string; name: string; status: PhaseStatus; branch: string | null; attempts: number; summary: string | null; commit_sha: string | null; started_at: string | null; finished_at: string | null };
export type PhaseStatus = "pending" | "preparing" | "running" | "verifying" | "fixing" | "passed" | "blocked" | "paused" | "stopped" | "interrupted" | "skipped";

export function listProjects(): ProjectRow[] {
  return getDb().all<ProjectRow>("SELECT * FROM projects ORDER BY updated_at DESC");
}

export function getProject(idOrName: number | string): ProjectRow {
  const row = typeof idOrName === "number"
    ? getDb().get<ProjectRow>("SELECT * FROM projects WHERE id = ?", idOrName)
    : getDb().get<ProjectRow>("SELECT * FROM projects WHERE name = ?", idOrName);
  if (!row) throw new Error(`Project ${idOrName} not found`);
  return row;
}

export function findProject(name: string): ProjectRow | undefined {
  return getDb().get<ProjectRow>("SELECT * FROM projects WHERE name = ?", slugify(name));
}

export function touchProject(id: number) {
  getDb().update("projects", id, { updated_at: now() });
}

export async function createProject(input: { name: string; engine?: string; description?: string; path?: string }): Promise<ProjectRow> {
  const config = loadConfig();
  const name = slugify(input.name);
  if (!validProjectName(name)) throw new Error("Project names use lowercase letters, numbers and dashes.");
  if (findProject(name)) throw new Error(`A project called ${name} already exists.`);
  const engine = input.engine ?? effectiveDefaultEngine();
  assertSelectableEngine(engine);
  const projectPath = input.path ? path.resolve(input.path) : confine(config.projectsDir, name);
  const meadowRoot = overlapsMeadow(projectPath);
  if (meadowRoot) throw new Error(meadowOverlapMessage(projectPath, meadowRoot));
  fs.mkdirSync(projectPath, { recursive: true });
  await ensureRepo(projectPath);
  fs.mkdirSync(path.join(projectPath, ".meadow"), { recursive: true });
  const rules = path.join(projectPath, ".meadow", "rules.md");
  if (!fs.existsSync(rules)) fs.writeFileSync(rules, "");
  const baseBranch = await currentBranch(projectPath);
  const id = getDb().insert("projects", {
    name,
    path: projectPath,
    engine,
    description: input.description ?? "",
    screenshots: 1,
    base_branch: baseBranch,
    created_at: now(),
    updated_at: now(),
  });
  bus.emitEvent({ type: "message", projectId: id, title: `Project ${name} created`, detail: projectPath });
  return getProject(id);
}

export function updateProject(id: number, patch: Partial<Pick<ProjectRow, "engine" | "description" | "screenshots">>) {
  if (patch.engine) assertSelectableEngine(patch.engine);
  getDb().update("projects", id, { ...patch, updated_at: now() });
  return getProject(id);
}

/** Moves projects off engines that can no longer be selected. The adapter and its settings are left untouched. */
export function migrateUnavailableEngines(): Array<{ project: string; from: string; to: string }> {
  const fallback = effectiveDefaultEngine();
  const moved: Array<{ project: string; from: string; to: string }> = [];
  for (const project of getDb().all<ProjectRow>("SELECT * FROM projects")) {
    if (engineStatus(project.engine) === "available") continue;
    getDb().update("projects", project.id, { engine: fallback, updated_at: now() });
    bus.emitEvent({ type: "guard", projectId: project.id, title: `Engine switched to ${engineLabel(fallback)}`, detail: `${engineLabel(project.engine)} is ${engineStatus(project.engine) === "coming_soon" ? "coming soon" : "not available"}, so this project now uses ${engineLabel(fallback)}. Your ${engineLabel(project.engine)} settings are kept.` });
    moved.push({ project: project.name, from: project.engine, to: fallback });
  }
  return moved;
}

export function projectRules(project: ProjectRow): string {
  try {
    return fs.readFileSync(path.join(project.path, ".meadow", "rules.md"), "utf8");
  } catch {
    return "";
  }
}

export function latestPlan(projectId: number): PlanRow | undefined {
  return getDb().get<PlanRow>("SELECT * FROM plans WHERE project_id = ? ORDER BY version DESC LIMIT 1", projectId);
}

export function activePlan(projectId: number): PlanRow | undefined {
  return getDb().get<PlanRow>("SELECT * FROM plans WHERE project_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1", projectId);
}

export function planVersions(projectId: number): PlanRow[] {
  return getDb().all<PlanRow>("SELECT * FROM plans WHERE project_id = ? ORDER BY version DESC", projectId);
}

export function getPlan(id: number): PlanRow {
  const row = getDb().get<PlanRow>("SELECT * FROM plans WHERE id = ?", id);
  if (!row) throw new Error(`Plan ${id} not found`);
  return row;
}

/** Every edit creates a new version; nothing is overwritten. */
export function savePlanVersion(projectId: number, rawMd: string, options: { specMd?: string | null; source?: string } = {}): PlanRow {
  const result = parsePlan(rawMd);
  if (!result.ok) throw new Error(`Plan is invalid:\n${result.errors.map(error => `line ${error.line ?? "?"} ${error.field}: ${error.message}`).join("\n")}`);
  const previous = latestPlan(projectId);
  const id = getDb().insert("plans", {
    project_id: projectId,
    version: (previous?.version ?? 0) + 1,
    raw_md: rawMd,
    spec_md: options.specMd ?? previous?.spec_md ?? null,
    source: options.source ?? "user",
    status: "draft",
    created_at: now(),
  });
  touchProject(projectId);
  return getPlan(id);
}

export function phasesFor(planId: number): PhaseRow[] {
  return getDb().all<PhaseRow>("SELECT * FROM phases WHERE plan_id = ? ORDER BY idx", planId);
}

/**
 * Approving a plan writes SPEC.md/PLAN.md, commits them on the base branch, and creates phase rows.
 * Phases already passed in the previous approved version (same id and name) keep their status,
 * so add-feature plans append work instead of redoing finished phases.
 */
export async function approvePlan(planId: number): Promise<PlanRow> {
  const plan = getPlan(planId);
  const project = getProject(plan.project_id);
  const parsed = parsePlan(plan.raw_md);
  if (!parsed.ok) throw new Error("Cannot approve an invalid plan");
  const previous = activePlan(project.id);
  const previousPhases = previous ? phasesFor(previous.id) : [];

  if (!(await isClean(project.path))) {
    const branch = await currentBranch(project.path);
    if (branch !== project.base_branch) throw new Error(`The project is on ${branch} with uncommitted changes. Finish or roll back the current phase before approving a new plan.`);
  }
  if ((await currentBranch(project.path)) !== project.base_branch) {
    throw new Error(`The project is on branch ${await currentBranch(project.path)}; approve plans from ${project.base_branch} (roll back or finish the current phase first).`);
  }

  fs.writeFileSync(path.join(project.path, "PLAN.md"), plan.raw_md.endsWith("\n") ? plan.raw_md : plan.raw_md + "\n");
  if (plan.spec_md) fs.writeFileSync(path.join(project.path, "SPEC.md"), plan.spec_md.endsWith("\n") ? plan.spec_md : plan.spec_md + "\n");
  await commitAll(project.path, `meadow: plan v${plan.version} approved`);

  const db = getDb();
  if (previous) db.update("plans", previous.id, { status: "superseded" });
  db.update("plans", plan.id, { status: "approved" });
  parsed.plan.phases.forEach((phase, idx) => {
    const carried = previousPhases.find(old => old.phase_key === phase.id && old.name === phase.name && old.status === "passed");
    db.insert("phases", {
      plan_id: plan.id,
      idx,
      phase_key: phase.id,
      name: phase.name,
      status: carried ? "passed" : "pending",
      branch: carried?.branch ?? null,
      attempts: carried?.attempts ?? 0,
      summary: carried?.summary ?? null,
      commit_sha: carried?.commit_sha ?? null,
      started_at: carried?.started_at ?? null,
      finished_at: carried?.finished_at ?? null,
    });
  });
  touchProject(project.id);
  bus.emitEvent({ type: "plan_ready", projectId: project.id, title: `Plan v${plan.version} approved`, detail: `${parsed.plan.phases.length} phases` });
  return getPlan(plan.id);
}

export function parsedActivePlan(projectId: number): { row: PlanRow; plan: Plan } | null {
  const row = activePlan(projectId);
  if (!row) return null;
  const parsed = parsePlan(row.raw_md);
  return parsed.ok ? { row, plan: parsed.plan } : null;
}

export function addNote(input: { projectId: number | null; title: string; body: string; source?: string }) {
  return getDb().insert("notes", { project_id: input.projectId, title: input.title, body: input.body, source: input.source ?? "note", created_at: now() });
}
