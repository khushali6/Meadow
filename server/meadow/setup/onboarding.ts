import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { ingestProject } from "../atlas/ingest";
import { bus } from "../core/events";
import { getSetting, putSetting } from "../core/settings";
import { activePlan, createProject, getProject, latestPlan, listProjects, savePlanVersion, type ProjectRow } from "../projects";
import { indexProject } from "../rag/index";
import { analyzeRepository, type RepoAnalysis } from "./analysis";
import { detectProject, type ProjectProfile } from "./detect";
import { liveGraph } from "./live";
import { baselineOf, type Baseline } from "./verify";

export const ONBOARDING_STEPS = ["environment", "repository", "llm", "codeatlas", "memory", "mcp", "telegram", "plan", "verify"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];
export type StepState = { status: "pending" | "running" | "done" | "skipped" | "failed"; detail: string; at: string };
export type OnboardingState = { projectId: number | null; completedAt: string | null; steps: Partial<Record<OnboardingStepId, StepState>> };

const KEY = "onboarding";

export function onboardingState(): OnboardingState & { needed: boolean } {
  const state = getSetting<OnboardingState>(KEY) ?? { projectId: null, completedAt: null, steps: {} };
  return { ...state, needed: !state.completedAt && listProjects().length === 0 };
}

export function markStep(id: OnboardingStepId, status: StepState["status"], detail = "", projectId?: number | null) {
  const state = getSetting<OnboardingState>(KEY) ?? { projectId: null, completedAt: null, steps: {} };
  state.steps[id] = { status, detail: detail.slice(0, 500), at: new Date().toISOString() };
  if (projectId !== undefined) state.projectId = projectId;
  putSetting(KEY, state);
  bus.emitEvent({ type: "setup", projectId: state.projectId, title: `Setup: ${id} ${status}`, detail, payload: { step: id, status } });
  return state;
}

export function completeOnboarding() {
  const state = getSetting<OnboardingState>(KEY) ?? { projectId: null, completedAt: null, steps: {} };
  putSetting(KEY, { ...state, completedAt: new Date().toISOString() });
}

export function resetOnboarding() {
  putSetting(KEY, { projectId: null, completedAt: null, steps: {} });
}

export class SetupError extends Error {}

/** Registers an existing repository as a project (or returns the one already registered for that folder). */
export async function registerRepository(root: string): Promise<{ project: ProjectRow; profile: ProjectProfile; created: boolean }> {
  if (!path.isAbsolute(root)) throw new SetupError("Use the full path to the repository.");
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new SetupError(`${resolved} is not a folder.`);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) throw new SetupError("Pick a project folder, not your home or root directory.");
  const profile = detectProject(resolved);
  const existing = listProjects().find(project => path.resolve(project.path) === resolved);
  if (existing) return { project: existing, profile, created: false };
  const base = path.basename(resolved).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  let name = base.length >= 2 ? base : `${base}-app`;
  for (let i = 2; listProjects().some(project => project.name === name); i++) name = `${base}-${i}`;
  const description = [profile.frameworks.join(", ") || profile.languages.join(", "), profile.git.remote ? `from ${profile.git.remote}` : ""].filter(Boolean).join(" ");
  const project = await createProject({ name, path: resolved, description });
  return { project, profile, created: true };
}

/** Builds the knowledge graph and local memory, reporting progress as it goes. */
export async function buildKnowledge(projectId: number, onProgress: (step: string, detail: string) => void = () => undefined) {
  const project = getProject(projectId);
  const graph = await ingestProject(projectId, (step, detail) => onProgress(step, detail ?? ""));
  onProgress("memory", "Embedding code and docs locally");
  const memory = await indexProject(projectId, project.path);
  await liveGraph.markIndexed(projectId).catch(() => undefined);
  return { graph, memory };
}

const yamlBlock = (data: unknown) => stringify(data, { lineWidth: 0 }).trimEnd();

/**
 * Turns the repository analysis into a first plan: make the baseline green, close the riskiest test gaps,
 * then the most-cited debt. Deterministic, so it never depends on a model being configured. Saved as a draft.
 */
export function initialPlanMarkdown(project: ProjectRow, profile: ProjectProfile, analysis: RepoAnalysis, baseline: Baseline | null): string {
  const passing = baseline?.results.filter(result => result.passed) ?? [];
  const failing = baseline?.results.filter(result => !result.passed) ?? [];
  const testCmd = profile.commands.find(command => command.kind === "test")?.cmd;
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  // Every phase needs a check that can fail: known commands first, otherwise a measurable condition on the tree.
  const gate = (preferred: string | undefined, fallback: Array<{ cmd: string }>) => {
    const cmds = [preferred, ...passing.map(result => result.cmd)].filter((cmd, i, all): cmd is string => Boolean(cmd) && all.indexOf(cmd) === i);
    return [...fallback, ...cmds.slice(0, 2).map(cmd => ({ cmd }))];
  };
  const hasTests = (dir: string) => ({ cmd: `find ${quote(dir)} -type f \\( -name '*test*' -o -name '*spec*' \\) -not -path '*/node_modules/*' | grep -q .` });
  const fewerMarkers = (file: string, now: number) => ({ cmd: `n=$(grep -cE 'TODO|FIXME|HACK|XXX' ${quote(file)} 2>/dev/null); test "\${n:-0}" -lt ${now}` });
  const writers = (table: string) => ({ cmd: `test "$(grep -rlE '(INSERT INTO|UPDATE)[[:space:]]+${table.replace(/[^A-Za-z0-9_]/g, "")}' --exclude-dir=node_modules --exclude-dir=.git . | cut -d/ -f2-3 | sort -u | wc -l)" -le 1` });
  const phases: Array<Record<string, unknown>> = [];
  const add = (phase: Record<string, unknown>) => phases.push({ id: `p${phases.length + 1}`, ...phase, ...(phases.length ? { depends_on: [`p${phases.length}`] } : {}) });

  if (failing.length) add({ name: "Make the baseline green", tasks: failing.map(result => `Fix \`${result.cmd}\` (exit ${result.exitCode ?? "timeout"}) without weakening the check`), checks: failing.map(result => ({ cmd: result.cmd })), done_when: "Every detected check passes" });
  const gaps = analysis.services.filter(service => service.tests === 0 && (service.callers || service.apis || service.incidents)).slice(0, 3);
  if (gaps.length) add({ name: `Tests for ${gaps.map(gap => gap.name).join(", ")}`, tasks: gaps.map(gap => `Add tests for ${gap.name} covering its ${gap.apis} API${gap.apis === 1 ? "" : "s"}${gap.incidents ? ` and the past incident path` : ""}`), checks: gate(testCmd, gaps.filter(gap => gap.path).map(gap => hasTests(gap.path!))), done_when: "New tests run in the test suite and pass" });
  else if (analysis.counts.files && !analysis.counts.tests) add({ name: "Add a test suite", tasks: [`Set up ${profile.testFrameworks[0] ?? "a test runner"} and cover the most-used modules${analysis.hotspots[0] ? ` starting with ${analysis.hotspots[0].path ?? analysis.hotspots[0].name}` : ""}`], checks: gate(testCmd, [hasTests(".")]), done_when: "The test command runs and passes" });
  for (const shared of analysis.sharedTables.slice(0, 1)) add({ name: `Single writer for ${shared.table}`, tasks: [`Route writes to ${shared.table} through one service instead of ${shared.writers.join(", ")}`, "Keep behaviour identical and cover it with a test"], checks: gate(testCmd, [writers(shared.table)]), done_when: `Only one service writes to ${shared.table}` });
  if (analysis.debt.length) add({ name: "Pay down marked debt", tasks: analysis.debt.slice(0, 4).map(item => `Resolve the ${item.markers} TODO/FIXME marker${item.markers === 1 ? "" : "s"} in ${item.path} or turn them into tracked issues`), checks: gate(undefined, analysis.debt.slice(0, 4).map(item => fewerMarkers(item.path, item.markers))), done_when: "Markers are resolved or documented, checks still pass" });
  if (!phases.length) add({ name: "Document the architecture", tasks: ["Write docs/ARCHITECTURE.md from the knowledge graph: services, data flow, ownership and how to run checks"], checks: [{ file_exists: "docs/ARCHITECTURE.md" }, { cmd: "test $(wc -l < docs/ARCHITECTURE.md) -ge 20" }, ...gate(undefined, [])], done_when: "The architecture doc exists and checks pass" });

  const front = {
    project: project.name,
    goal: `Leave ${project.name} safer to change: green checks, tests where the risk is, and less debt.`,
    stack: [...profile.languages, ...profile.frameworks].slice(0, 6),
    constraints: ["Do not change public APIs or database schemas unless a task says so", "Keep every existing check passing"],
    phases,
  };
  return `---\n${yamlBlock(front)}\n---\n\nInitial plan generated by Meadow from the repository analysis. Review and edit before approving.\n\n${analysis.summary}\n`;
}

export function generateInitialPlan(projectId: number): { planId: number; version: number; created: boolean } {
  const project = getProject(projectId);
  const latest = latestPlan(projectId);
  if (latest && (latest.status === "draft" || activePlan(projectId))) return { planId: latest.id, version: latest.version, created: false };
  const markdown = initialPlanMarkdown(project, detectProject(project.path), analyzeRepository(projectId), baselineOf(projectId) ?? null);
  const plan = savePlanVersion(projectId, markdown, { source: "initial" });
  return { planId: plan.id, version: plan.version, created: true };
}
