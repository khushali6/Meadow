import { getDb } from "../core/db";
import { gatherContext, contextSummary } from "../intake/context";
import { appendPhases } from "../intake/llm";
import { isConfigured } from "../llm/catalog";
import { chatProviderId } from "../llm/router";
import { parsePlan } from "../planning/format";
import { activePlan, getProject, latestPlan, savePlanVersion } from "../projects";
import { memoryStatus } from "../rag/index";
import { buildBrief, renderBrief, type ProjectBrief } from "./brief";

export type Suggestion = { id: string; label: string; detail: string; action: "plan_next" | "resume" | "start" | "review_approvals" | "retry" | "reembed" | "describe" | "approve_plan" };

export type ProjectStatus = {
  brief: ProjectBrief;
  execution: { status: string; startedAt: string; finishedAt: string | null } | null;
  nextPhase: { n: number; name: string } | null;
  blocked: Array<{ n: number; name: string; attempts: number }>;
  pendingApprovals: number;
  draftPlan: { id: number; version: number } | null;
  memory: { stale: number; chunks: number };
  suggestions: Suggestion[];
  canPlanNext: boolean;
};

/** Where the project stands and what to do next. Deterministic: no model call. */
export function projectStatus(projectId: number): ProjectStatus {
  const brief = buildBrief(projectId);
  const db = getDb();
  const execution = db.get<{ status: string; started_at: string; finished_at: string | null }>("SELECT status, started_at, finished_at FROM executions WHERE project_id = ? ORDER BY id DESC LIMIT 1", projectId);
  const pendingApprovals = db.get<{ n: number }>("SELECT COUNT(*) n FROM approvals WHERE project_id = ? AND status = 'pending'", projectId)?.n ?? 0;
  const active = activePlan(projectId);
  const latest = latestPlan(projectId);
  const draftPlan = latest && latest.status === "draft" && latest.id !== active?.id ? { id: latest.id, version: latest.version } : null;
  const next = brief.roadmap.find(item => item.status === "pending" || item.status === "not_started" || item.status === "paused" || item.status === "interrupted");
  const blocked = brief.roadmap.filter(item => item.status === "blocked").map(item => ({ n: item.n, name: item.name, attempts: item.attempts }));
  const memory = memoryStatus(projectId);
  const running = execution?.status === "running";
  const suggestions: Suggestion[] = [];
  if (draftPlan) suggestions.push({ id: "approve", label: `Review plan v${draftPlan.version}`, detail: "A new plan version is waiting for your approval. Nothing runs until you approve it.", action: "approve_plan" });
  if (pendingApprovals) suggestions.push({ id: "approvals", label: `${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} waiting`, detail: "Approvals expire and default to deny.", action: "review_approvals" });
  if (!brief.roadmap.length && !draftPlan) suggestions.push({ id: "describe", label: "Describe what to build", detail: "Meadow will ask a few questions and draft a plan.", action: "describe" });
  for (const item of blocked) suggestions.push({ id: `retry-${item.n}`, label: `Unblock phase ${item.n}: ${item.name}`, detail: `Stopped after ${item.attempts} attempts. Retry with a hint, skip it, or roll back.`, action: "retry" });
  if (!running && next && !blocked.length) suggestions.push({ id: "resume", label: execution ? `Resume at phase ${next.n}` : "Start the run", detail: `${next.name} is next.`, action: execution ? "resume" : "start" });
  if (memory.stale > 0) suggestions.push({ id: "reembed", label: `Re-embed ${memory.stale} stale chunks`, detail: "The embedding model changed since they were indexed.", action: "reembed" });
  const allDone = brief.roadmap.length > 0 && brief.roadmap.every(item => item.status === "passed" || item.status === "skipped");
  if (allDone && !draftPlan) suggestions.push({ id: "next", label: "Plan next steps", detail: "Propose the next phases toward the goal as a new plan version for your approval.", action: "plan_next" });
  return {
    brief,
    execution: execution ? { status: execution.status, startedAt: execution.started_at, finishedAt: execution.finished_at } : null,
    nextPhase: next ? { n: next.n, name: next.name } : null,
    blocked,
    pendingApprovals,
    draftPlan,
    memory: { stale: memory.stale, chunks: memory.chunks },
    suggestions,
    canPlanNext: Boolean(active) && !running && !draftPlan && isConfigured(chatProviderId()),
  };
}

export class PlanNextError extends Error {
  constructor(readonly code: "NO_PLAN" | "RUNNING" | "DRAFT_PENDING" | "NO_MODEL" | "INVALID_PLAN", message: string) {
    super(message);
  }
}

/**
 * Asks the agent model for the next phases, with the full brief as context, and saves them as a
 * new draft plan version. Finished phases are kept unchanged and nothing runs until approval.
 */
export async function planNextSteps(projectId: number, request?: string): Promise<{ planId: number; version: number; added: string[] }> {
  const status = projectStatus(projectId);
  const active = activePlan(projectId);
  if (!active) throw new PlanNextError("NO_PLAN", "There is no approved plan yet. Describe what to build first.");
  if (status.execution?.status === "running") throw new PlanNextError("RUNNING", "A run is in progress. Plan next steps once it finishes or is paused.");
  if (status.draftPlan) throw new PlanNextError("DRAFT_PENDING", `Plan v${status.draftPlan.version} is already waiting for approval.`);
  if (!isConfigured(chatProviderId())) throw new PlanNextError("NO_MODEL", "Planning needs an agent model. Configure one in Runtime settings → Agent model.");
  const project = getProject(projectId);
  const brief = renderBrief(status.brief, 5000);
  const goal = request?.trim() || (status.blocked.length
    ? `Phases ${status.blocked.map(item => item.n).join(", ")} are blocked. Propose the next phases: first address the root cause of the blocker, then continue toward the goal.`
    : "Propose the next logical phases toward the project goal, based on what has been built and what is still missing.");
  const context = contextSummary(await gatherContext(project.path));
  const planMd = await appendPhases({ existingPlan: active.raw_md, request: `${goal}\n\nProject brief:\n${brief}`, kind: "add_feature", spec: active.spec_md, context });
  const parsed = parsePlan(planMd);
  if (!parsed.ok) throw new PlanNextError("INVALID_PLAN", "The model returned an invalid plan. Try again or edit the plan by hand.");
  const before = new Set(parsePlan(active.raw_md).plan?.phases.map(phase => phase.id) ?? []);
  const added = parsed.plan.phases.filter(phase => !before.has(phase.id)).map(phase => phase.name);
  const spec = active.spec_md ? `${active.spec_md.trimEnd()}\n\n## Next steps (${new Date().toISOString().slice(0, 10)})\n${goal}\n` : null;
  const plan = savePlanVersion(projectId, planMd, { specMd: spec, source: "next_steps" });
  return { planId: plan.id, version: plan.version, added };
}
