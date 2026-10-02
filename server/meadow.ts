import fs from "node:fs";
import path from "node:path";

export type ProjectStatus = "ready" | "running" | "paused" | "blocked" | "stopped";
export type PhaseStatus = "passed" | "running" | "queued" | "blocked" | "paused" | "stopped";
export type RunStatus = "completed" | "running" | "paused" | "stopped" | "blocked";
export type EventType = "phase_started" | "thinking" | "tool_call" | "file_edit" | "command_run" | "check_result" | "screenshot" | "phase_passed" | "approval_requested" | "message" | "error" | "done";

export type MeadowEvent = {
  id: number;
  runId: string;
  ts: string;
  type: EventType;
  title: string;
  detail: string;
  meta?: string;
  phaseId?: string;
};

export type MeadowPhase = {
  id: string;
  index: number;
  name: string;
  summary: string;
  status: PhaseStatus;
  branch: string;
  attempts: number;
  checks: { label: string; command: string; status: "passed" | "running" | "queued" }[];
};

export type MeadowProject = {
  id: string;
  name: string;
  path: string;
  engine: string;
  description: string;
  status: ProjectStatus;
  currentPhase: number;
  updatedAt: string;
  phases: MeadowPhase[];
};

export type MeadowRun = {
  id: string;
  projectId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  phaseIndex: number;
  tokens: number;
  budget: number;
  changedFiles: number;
  diff: { path: string; additions: number; deletions: number; kind: "modified" | "added" }[];
};

export type Approval = { id: string; title: string; detail: string; risk: "medium" | "high"; requestedAt: string; status: "pending" | "approved" | "denied" };
export type MemoryNote = { id: string; title: string; body: string; source: string; updatedAt: string };
export type MeadowSettings = { notificationLevel: "all" | "phases" | "failures"; screenshotEnabled: boolean; previewUrl: string; budget: number; quietHours: boolean; theme: "light" | "dark" };

type MeadowState = {
  projects: MeadowProject[];
  runs: MeadowRun[];
  events: MeadowEvent[];
  approvals: Approval[];
  notes: MemoryNote[];
  settings: MeadowSettings;
  nextEventId: number;
};

const stateFile = path.join(process.cwd(), "data", "meadow-state.json");
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const iso = (offsetMinutes = 0) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

function seedState(): MeadowState {
  const projectId = "meadow-console";
  const phases: MeadowPhase[] = [
    { id: "phase-1", index: 1, name: "Foundation & shell", summary: "Scaffold the app and establish the visual language.", status: "passed", branch: "meadow/phase-1-foundation", attempts: 1, checks: [{ label: "Build", command: "pnpm build", status: "passed" }, { label: "Typecheck", command: "pnpm check", status: "passed" }] },
    { id: "phase-2", index: 2, name: "Projects & state", summary: "Persist projects, phases, and live run state.", status: "passed", branch: "meadow/phase-2-state", attempts: 1, checks: [{ label: "Schema", command: "pnpm db:migrate", status: "passed" }, { label: "API smoke", command: "pnpm test -- server", status: "passed" }] },
    { id: "phase-3", index: 3, name: "Run harness", summary: "Stream engine events and verify every phase.", status: "running", branch: "meadow/phase-3-harness", attempts: 1, checks: [{ label: "Event replay", command: "pnpm test -- harness", status: "running" }, { label: "Health", command: "GET /api/health", status: "queued" }] },
    { id: "phase-4", index: 4, name: "Evidence & approvals", summary: "Make diffs, checks, screenshots, and approvals visible.", status: "queued", branch: "meadow/phase-4-evidence", attempts: 0, checks: [{ label: "Approval flow", command: "pnpm test -- approvals", status: "queued" }, { label: "Capture", command: "pnpm test -- screenshots", status: "queued" }] },
    { id: "phase-5", index: 5, name: "Hardening & docs", summary: "Lock down safety copy and ship a usable release.", status: "queued", branch: "meadow/phase-5-hardening", attempts: 0, checks: [{ label: "Lint", command: "pnpm lint", status: "queued" }, { label: "Release build", command: "pnpm build", status: "queued" }] },
  ];
  const project: MeadowProject = { id: projectId, name: "meadow-console", path: "~/meadow-projects/meadow-console", engine: "Cursor CLI", description: "A calm command center for AI-built software on your own machine.", status: "running", currentPhase: 3, updatedAt: iso(-2), phases };
  const runId = "run-2026-10-02-001";
  const events: MeadowEvent[] = [
    { id: 1, runId, ts: iso(-13), type: "phase_started", title: "Phase 3 started", detail: "Run harness · branch meadow/phase-3-harness", phaseId: "phase-3" },
    { id: 2, runId, ts: iso(-12), type: "thinking", title: "Reading phase context", detail: "Compiling the prompt with 4 relevant files and 2 memory hits.", meta: "2.1s", phaseId: "phase-3" },
    { id: 3, runId, ts: iso(-11), type: "tool_call", title: "git status --short", detail: "Working tree clean · 0 uncommitted changes", meta: "shell", phaseId: "phase-3" },
    { id: 4, runId, ts: iso(-10), type: "file_edit", title: "Updated runner.py", detail: "Added a bounded retry loop with no-output watchdog.", meta: "+42 −8", phaseId: "phase-3" },
    { id: 5, runId, ts: iso(-8), type: "command_run", title: "pytest -q tests/harness", detail: "14 passed in 3.82s", meta: "exit 0", phaseId: "phase-3" },
    { id: 6, runId, ts: iso(-6), type: "check_result", title: "Event replay check passed", detail: "Last event id can resume without duplicating messages.", meta: "passed", phaseId: "phase-3" },
    { id: 7, runId, ts: iso(-3), type: "screenshot", title: "Preview captured", detail: "Desktop · /dashboard · 1280×800", meta: "screenshot", phaseId: "phase-3" },
    { id: 8, runId, ts: iso(-1), type: "message", title: "Waiting on a decision", detail: "The harness is ready to continue after this phase.", phaseId: "phase-3" },
  ];
  return {
    projects: [project],
    runs: [{ id: runId, projectId, status: "running", startedAt: iso(-15), phaseIndex: 3, tokens: 8420, budget: 25000, changedFiles: 9, diff: [{ path: "src/meadow/harness/runner.py", additions: 42, deletions: 8, kind: "modified" }, { path: "tests/harness/test_replay.py", additions: 86, deletions: 0, kind: "added" }, { path: "docs/phase-3.md", additions: 18, deletions: 2, kind: "modified" }] }],
    events,
    approvals: [{ id: "approval-1", title: "Install Playwright browser", detail: "The visual capture phase wants to install Chromium into the local tool cache.", risk: "medium", requestedAt: iso(-24), status: "pending" }, { id: "approval-2", title: "Push phase branch to origin", detail: "A remote operation will publish meadow/phase-2-state for backup.", risk: "high", requestedAt: iso(-110), status: "approved" }],
    notes: [{ id: "note-1", title: "Project boundary", body: "Meadow only writes inside the selected project root. Do not widen this path without an explicit approval.", source: "MEMORY.md", updatedAt: iso(-65) }, { id: "note-2", title: "Engine preference", body: "Cursor is the default engine; Claude Code is an optional adapter for existing subscribers.", source: "Project rules", updatedAt: iso(-180) }, { id: "note-3", title: "Preview contract", body: "Capture localhost routes only and stop the preview process after screenshots.", source: ".meadow/preview.toml", updatedAt: iso(-340) }],
    settings: { notificationLevel: "phases", screenshotEnabled: true, previewUrl: "http://localhost:3000", budget: 25000, quietHours: false, theme: "light" },
    nextEventId: 9,
  };
}

let state: MeadowState | null = null;

function save() {
  if (!state) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn("[Meadow] state save skipped", error);
  }
}

function getState() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as MeadowState;
  } catch {
    state = seedState();
    save();
  }
  return state;
}

const nowLabel = () => new Date().toISOString();
const projectFor = (projectId?: string) => getState().projects.find(project => project.id === projectId) ?? getState().projects[0];
const runFor = (projectId?: string) => getState().runs.find(run => run.projectId === projectId) ?? getState().runs[0];

function pushEvent(runId: string, event: Omit<MeadowEvent, "id" | "runId" | "ts">) {
  const current = getState();
  current.events.push({ ...event, id: current.nextEventId++, runId, ts: nowLabel() });
  save();
}

function schedule(runId: string, fn: () => void, delay = 1050) {
  const timer = setTimeout(() => {
    timers.delete(runId);
    fn();
  }, delay);
  timers.set(runId, timer);
}

function simulateRun(runId: string) {
  const current = getState();
  const run = current.runs.find(item => item.id === runId);
  if (!run) return;
  if (run.status !== "running") {
    if (run.status === "paused") schedule(runId, () => simulateRun(runId), 1300);
    return;
  }
  const project = projectFor(run.projectId);
  const phase = project.phases[run.phaseIndex - 1];
  if (!phase) return;
  const phaseEvents: Array<Omit<MeadowEvent, "id" | "runId" | "ts">> = [
    { type: "phase_started", title: `Phase ${phase.index} started`, detail: `${phase.name} · branch ${phase.branch}`, phaseId: phase.id },
    { type: "thinking", title: "Compiling phase prompt", detail: "Gathering project rules, previous summaries, and relevant files.", meta: "1.8s", phaseId: phase.id },
    { type: "tool_call", title: "git diff --stat", detail: "Working tree checked before engine handoff.", meta: "shell", phaseId: phase.id },
    { type: "file_edit", title: `Updated ${phase.index === 3 ? "harness/runner.py" : "src/meadow/module.py"}`, detail: "Applied the smallest scoped change for this phase.", meta: "+24 −6", phaseId: phase.id },
    { type: "command_run", title: phase.checks[0]?.command ?? "pnpm check", detail: "All assertions passed with exit code 0.", meta: "exit 0", phaseId: phase.id },
    { type: "check_result", title: `${phase.checks[0]?.label ?? "Acceptance"} check passed`, detail: phase.summary, meta: "passed", phaseId: phase.id },
    { type: "screenshot", title: "Preview captured", detail: "Desktop · /dashboard · 1280×800", meta: "screenshot", phaseId: phase.id },
    { type: "phase_passed", title: `Phase ${phase.index} passed`, detail: "Checks are green. The branch is ready for review.", meta: "done", phaseId: phase.id },
  ];
  const event = phaseEvents[Math.min(phaseEvents.length - 1, Math.max(0, current.events.filter(item => item.runId === runId && item.phaseId === phase.id).length))];
  pushEvent(runId, event);
  const phaseCount = current.events.filter(item => item.runId === runId && item.phaseId === phase.id).length;
  if (phaseCount >= phaseEvents.length) {
    phase.status = "passed";
    phase.checks = phase.checks.map(check => ({ ...check, status: "passed" }));
    if (run.phaseIndex < project.phases.length) {
      run.phaseIndex += 1;
      project.currentPhase = run.phaseIndex;
      project.phases[run.phaseIndex - 1].status = "running";
      project.phases[run.phaseIndex - 1].attempts = Math.max(1, project.phases[run.phaseIndex - 1].attempts);
    } else {
      run.status = "completed";
      run.finishedAt = nowLabel();
      project.status = "ready";
      pushEvent(runId, { type: "done", title: "Run completed", detail: "Every phase passed and the working tree is clean.", meta: "all green" });
    }
  }
  project.updatedAt = nowLabel();
  run.tokens += 220;
  save();
  if (run.status === "running") schedule(runId, () => simulateRun(runId));
}

export function snapshot() {
  const current = getState();
  const project = current.projects[0];
  const run = current.runs.find(item => item.projectId === project?.id) ?? current.runs[0];
  return { ...current, activeProjectId: project?.id, activeRunId: run?.id };
}

export function createProject(input: { name: string; engine: string; description?: string }) {
  const current = getState();
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `project-${current.projects.length + 1}`;
  const id = `${slug}-${Date.now()}`;
  const project: MeadowProject = { id, name: slug, path: `~/meadow-projects/${slug}`, engine: input.engine, description: input.description || "A new Meadow project ready for its first plan.", status: "ready", currentPhase: 1, updatedAt: nowLabel(), phases: [{ id: `${id}-phase-1`, index: 1, name: "Plan and scaffold", summary: "Turn the request into a bounded, testable first phase.", status: "queued", branch: `meadow/${slug}-phase-1`, attempts: 0, checks: [{ label: "Build", command: "pnpm build", status: "queued" }, { label: "Smoke", command: "GET /", status: "queued" }] }] };
  current.projects.unshift(project);
  current.runs.unshift({ id: `run-${Date.now()}`, projectId: id, status: "stopped", startedAt: nowLabel(), phaseIndex: 1, tokens: 0, budget: current.settings.budget, changedFiles: 0, diff: [] });
  save();
  return project;
}

export function startRun(projectId: string) {
  const current = getState();
  const project = projectFor(projectId);
  const run = current.runs.find(item => item.projectId === project.id) ?? current.runs[0];
  if (!run || !project) throw new Error("Project not found");
  if (run.status === "completed" || run.status === "stopped") {
    run.status = "running";
    run.startedAt = nowLabel();
    run.finishedAt = undefined;
    run.phaseIndex = Math.min(project.currentPhase, project.phases.length);
  } else {
    run.status = "running";
  }
  project.status = "running";
  project.phases[run.phaseIndex - 1].status = "running";
  pushEvent(run.id, { type: "message", title: "Run resumed from dashboard", detail: `Meadow is running ${project.phases[run.phaseIndex - 1].name}.`, phaseId: project.phases[run.phaseIndex - 1].id });
  save();
  if (!timers.has(run.id)) schedule(run.id, () => simulateRun(run.id), 500);
  return run;
}

export function controlRun(runId: string, action: "pause" | "resume" | "stop" | "retry" | "rollback") {
  const current = getState();
  const run = current.runs.find(item => item.id === runId);
  if (!run) throw new Error("Run not found");
  const project = projectFor(run.projectId);
  if (action === "pause") { run.status = "paused"; project.status = "paused"; pushEvent(run.id, { type: "message", title: "Run paused", detail: "The harness will wait here until you resume.", phaseId: project.phases[run.phaseIndex - 1]?.id }); }
  if (action === "resume") { run.status = "running"; project.status = "running"; pushEvent(run.id, { type: "message", title: "Run resumed", detail: "Continuing with the current phase.", phaseId: project.phases[run.phaseIndex - 1]?.id }); if (!timers.has(run.id)) schedule(run.id, () => simulateRun(run.id), 400); }
  if (action === "stop") { run.status = "stopped"; project.status = "stopped"; project.phases[run.phaseIndex - 1].status = "stopped"; pushEvent(run.id, { type: "message", title: "Run stopped", detail: "No more engine work will be started for this run.", phaseId: project.phases[run.phaseIndex - 1]?.id }); }
  if (action === "retry") { run.status = "running"; project.status = "running"; project.phases[run.phaseIndex - 1].attempts += 1; project.phases[run.phaseIndex - 1].status = "running"; pushEvent(run.id, { type: "message", title: "Retrying current phase", detail: `Attempt ${project.phases[run.phaseIndex - 1].attempts} · previous evidence kept for review.`, phaseId: project.phases[run.phaseIndex - 1]?.id }); if (!timers.has(run.id)) schedule(run.id, () => simulateRun(run.id), 400); }
  if (action === "rollback") { const target = Math.max(1, run.phaseIndex - 1); run.phaseIndex = target; project.currentPhase = target; project.status = "ready"; project.phases.forEach((phase, index) => { phase.status = index < target - 1 ? "passed" : index === target - 1 ? "queued" : "queued"; }); run.status = "stopped"; pushEvent(run.id, { type: "message", title: `Rolled back to phase ${target}`, detail: "The last passing branch is now the active baseline.", phaseId: project.phases[target - 1]?.id }); }
  project.updatedAt = nowLabel();
  save();
  return run;
}

export function decideApproval(id: string, decision: "approved" | "denied") {
  const approval = getState().approvals.find(item => item.id === id);
  if (!approval) throw new Error("Approval not found");
  approval.status = decision;
  save();
  return approval;
}

export function updateSettings(input: Partial<MeadowSettings>) {
  const current = getState();
  current.settings = { ...current.settings, ...input };
  save();
  return current.settings;
}

export function addNote(input: { title: string; body: string }) {
  const note: MemoryNote = { id: `note-${Date.now()}`, title: input.title, body: input.body, source: "MEMORY.md", updatedAt: nowLabel() };
  getState().notes.unshift(note);
  save();
  return note;
}

export function validatePlan(markdown: string) {
  const phaseCount = (markdown.match(/^## Phase /gm) ?? []).length;
  const hasChecks = /check|test|build|lint/i.test(markdown);
  return { valid: phaseCount > 0 && hasChecks, phaseCount, errors: phaseCount === 0 ? ["No phase headings found. Add at least one `## Phase N — Name` section."] : hasChecks ? [] : ["Every phase needs at least one runnable check."] };
}
