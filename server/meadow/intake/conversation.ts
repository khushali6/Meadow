import { loadConfig, saveConfig, type NotificationLevel } from "../config";
import { decide } from "../core/approvals";
import { getDb, now } from "../core/db";
import { slugify } from "../core/paths";
import { redact } from "../core/redact";
import { engineNames } from "../engines/registry";
import { harness } from "../harness/runner";
import { formatErrors, parsePlan } from "../planning/format";
import { addNote, approvePlan, createProject, findProject, getPlan, getProject, latestPlan, listProjects, savePlanVersion, updateProject } from "../projects";
import { indexMemory, indexProject, search } from "../rag/index";
import { planSummaryText, projectDetail, statusText, usageToday } from "../service";
import { contextSummary, gatherContext } from "./context";
import { answerQuestion, appendPhases, buildSpec, classify, clarifyQuestions, generatePlan, improvePlan, looksLikePlanFile, projectNameFor, type Intent, type Question } from "./llm";

export type Button = { label: string; action: string };
export type Reply = { text: string; buttons?: Button[][]; planId?: number; shot?: { projectId: number; route: string | null } };

type ConversationState = {
  stage: "idle" | "clarifying" | "plan_review" | "awaiting_hint" | "awaiting_feature";
  activeProjectId: number | null;
  intent?: Intent;
  request?: string;
  projectName?: string;
  questions?: Question[];
  answers?: Array<{ question: string; answer: string; assumed: boolean }>;
  planId?: number;
  hintProjectId?: number;
};

const emptyState = (): ConversationState => ({ stage: "idle", activeProjectId: null });

export function loadState(channel: string, chatId: string): ConversationState {
  const row = getDb().get<{ state_json: string }>("SELECT state_json FROM conversations WHERE channel = ? AND chat_id = ?", channel, chatId);
  if (!row) {
    const state = emptyState();
    state.activeProjectId = listProjects()[0]?.id ?? null;
    return state;
  }
  return { ...emptyState(), ...(JSON.parse(row.state_json) as ConversationState) };
}

function saveState(channel: string, chatId: string, state: ConversationState) {
  getDb().run("INSERT INTO conversations (channel, chat_id, state_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(channel, chat_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at", channel, chatId, JSON.stringify(state), now());
}

function questionReply(state: ConversationState): Reply {
  const index = state.answers!.length;
  const question = state.questions![index];
  const buttons: Button[][] = question.options.map((option, i) => [{ label: option === question.default ? `${option} (default)` : option, action: `answer:${i}` }]);
  buttons.push([{ label: "Just decide", action: "decide" }, { label: "Cancel", action: "cancel" }]);
  return { text: `Question ${index + 1} of ${state.questions!.length}: ${question.text}\n\nTap an option or type your own answer.`, buttons };
}

function reviewReply(planId: number, intro: string): Reply {
  const plan = getPlan(planId);
  const parsed = parsePlan(plan.raw_md);
  const summary = parsed.ok ? planSummaryText(parsed.plan, plan.version) : plan.raw_md.slice(0, 1500);
  const warnings = parsed.ok && parsed.warnings.length ? `\n\nNotes:\n${parsed.warnings.map(w => `- ${w.message}`).join("\n")}` : "";
  return {
    text: `${intro}\n\n${summary}${warnings}\n\nNothing runs until you approve.`,
    buttons: [[{ label: "Approve and start", action: `approve:${planId}` }], [{ label: "Edit", action: `edit:${planId}` }, { label: "Improve checks", action: `improve:${planId}` }, { label: "Cancel", action: "cancel" }]],
    planId,
  };
}

async function uniqueName(base: string) {
  let name = slugify(base) || "project";
  let i = 2;
  while (findProject(name)) name = `${slugify(base)}-${i++}`;
  return name;
}

async function finalizeRequest(state: ConversationState): Promise<Reply> {
  const request = state.request!;
  const answers = state.answers ?? [];
  if (state.intent === "new_project") {
    const name = await uniqueName(state.projectName ?? "project");
    const spec = await buildSpec({ request, answers, context: "Empty project.", projectName: name });
    const planMd = await generatePlan({ spec, projectName: name, context: "Empty project." });
    const project = await createProject({ name, description: request.slice(0, 200) });
    const plan = savePlanVersion(project.id, planMd, { specMd: spec, source: "generated" });
    state.activeProjectId = project.id;
    state.stage = "plan_review";
    state.planId = plan.id;
    return reviewReply(plan.id, `Here is the plan for ${name}. Spec saved as SPEC.md.`);
  }
  const project = getProject(state.activeProjectId!);
  const context = await gatherContext(project.path);
  const current = latestPlan(project.id);
  if (!current) {
    const spec = await buildSpec({ request, answers, context: contextSummary(context), projectName: project.name });
    const planMd = await generatePlan({ spec, projectName: project.name, context: contextSummary(context) });
    const plan = savePlanVersion(project.id, planMd, { specMd: spec, source: "generated" });
    state.stage = "plan_review";
    state.planId = plan.id;
    return reviewReply(plan.id, `Here is a plan for ${project.name}.`);
  }
  const kind = state.intent === "fix_bug" ? "fix_bug" : "add_feature";
  const fullRequest = `${request}${answers.length ? `\n\nClarifications:\n${answers.map(a => `- ${a.question}: ${a.answer}${a.assumed ? " (assumed)" : ""}`).join("\n")}` : ""}`;
  const planMd = await appendPhases({ existingPlan: current.raw_md, request: fullRequest, kind, spec: current.spec_md, context: contextSummary(context) });
  const spec = current.spec_md ? `${current.spec_md.trimEnd()}\n\n## ${kind === "fix_bug" ? "Bug fix" : "Feature"} request (${now().slice(0, 10)})\n${fullRequest}\n` : null;
  const plan = savePlanVersion(project.id, planMd, { specMd: spec, source: "generated" });
  state.stage = "plan_review";
  state.planId = plan.id;
  return reviewReply(plan.id, `I appended ${kind === "fix_bug" ? "a bug-fix phase (reproduce with a failing test first)" : "new phases"} to ${project.name}. Finished phases are untouched.`);
}

async function startIntake(state: ConversationState, text: string, intent: Intent, hint: string | null): Promise<Reply> {
  state.intent = intent;
  state.request = text;
  state.answers = [];
  let context = "Empty project.";
  if (intent === "new_project") {
    state.projectName = slugify(await projectNameFor(text, hint && !findProject(hint) ? hint : null));
  } else {
    const project = getProject(state.activeProjectId!);
    context = contextSummary(await gatherContext(project.path));
  }
  state.questions = await clarifyQuestions(text, intent, context);
  if (!state.questions.length) return finalizeRequest(state);
  state.stage = "clarifying";
  return questionReply(state);
}

async function recordAnswer(state: ConversationState, answer: string, assumed = false): Promise<Reply> {
  const question = state.questions![state.answers!.length];
  state.answers!.push({ question: question.text, answer, assumed });
  if (state.answers!.length < state.questions!.length) return questionReply(state);
  state.stage = "idle";
  return finalizeRequest(state);
}

async function justDecide(state: ConversationState): Promise<Reply> {
  for (const question of state.questions!.slice(state.answers!.length)) state.answers!.push({ question: question.text, answer: question.default ?? question.options[0] ?? "Your call", assumed: true });
  state.stage = "idle";
  return finalizeRequest(state);
}

function controlFromText(text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(pause|hold on|wait)\b/.test(t)) return "pause";
  if (/\b(resume|continue|go on|carry on|keep going)\b/.test(t)) return "continue";
  if (/\b(stop|cancel|abort|kill)\b/.test(t)) return "stop";
  if (/\b(roll ?back|undo|revert)\b/.test(t)) return "rollback";
  if (/\b(retry|try again)\b/.test(t)) return "retry";
  return null;
}

function requireProject(state: ConversationState): number {
  if (!state.activeProjectId) throw new Error("No project selected. Use /project <name> or describe a new project.");
  return state.activeProjectId;
}

export async function control(state: ConversationState, verb: string, projectId: number, hint?: string): Promise<Reply> {
  switch (verb) {
    case "pause":
      harness.pause(projectId);
      return { text: "Pausing after the current engine step." };
    case "continue":
    case "resume":
      await harness.start(projectId);
      return { text: "Continuing." };
    case "stop":
      await harness.stop(projectId);
      return { text: "Stopped." };
    case "retry":
      await harness.retry(projectId, hint);
      return { text: hint ? "Retrying with your hint." : "Retrying the current phase." };
    case "skip":
      await harness.skipPhase(projectId);
      return { text: "Phase skipped. Its branch is kept under failed/.", buttons: [[{ label: "Continue", action: `continue:${projectId}` }]] };
    case "rollback":
      return { text: "Roll back to the last passing phase? The current branch is kept under failed/ for inspection.", buttons: [[{ label: "Yes, roll back", action: `rollback_confirm:${projectId}` }, { label: "No", action: "noop" }]] };
    case "rollback_confirm":
      await harness.rollback(projectId);
      return { text: "Rolled back to the last passing phase." };
    default:
      return { text: `Unknown action ${verb}.` };
  }
}

export async function handleText(channel: string, chatId: string, text: string): Promise<Reply> {
  const state = loadState(channel, chatId);
  try {
    const reply = await routeText(state, text.trim());
    saveState(channel, chatId, state);
    return reply;
  } catch (error) {
    saveState(channel, chatId, state);
    return { text: `Something went wrong: ${redact((error as Error).message)}` };
  }
}

async function routeText(state: ConversationState, text: string): Promise<Reply> {
  if (!text) return { text: "Send a request, or /help for commands." };
  if (text.startsWith("/")) return command(state, text);
  if (state.stage === "clarifying") {
    if (/^(just decide|you decide|whatever|skip|defaults?)$/i.test(text)) return justDecide(state);
    return recordAnswer(state, text);
  }
  if (state.stage === "awaiting_hint" && state.hintProjectId) {
    const projectId = state.hintProjectId;
    state.stage = "idle";
    state.hintProjectId = undefined;
    return control(state, "retry", projectId, text);
  }
  if (state.stage === "awaiting_feature") {
    state.stage = "idle";
    return startIntake(state, text, "add_feature", null);
  }
  if (looksLikePlanFile(text)) return importPlan(state, text);
  const projects = listProjects();
  const active = state.activeProjectId ? projects.find(project => project.id === state.activeProjectId) : undefined;
  const result = await classify(text, projects.map(project => project.name), active?.name ?? null);
  if (result.project_hint && result.intent !== "new_project") {
    const match = findProject(result.project_hint);
    if (match) state.activeProjectId = match.id;
  }
  if (result.confidence < 0.5) {
    return { text: "I'm not sure what you want me to do. Is this a new project, a change to an existing one, or a question?", buttons: [[{ label: "New project", action: "intent:new_project" }, { label: "Add feature", action: "intent:add_feature" }], [{ label: "Fix a bug", action: "intent:fix_bug" }, { label: "Question", action: "intent:question" }]] };
  }
  state.request = text;
  return routeIntent(state, result.intent, text, result.project_hint);
}

async function routeIntent(state: ConversationState, intent: Intent, text: string, hint: string | null): Promise<Reply> {
  switch (intent) {
    case "new_project":
      return startIntake(state, text, "new_project", hint);
    case "add_feature":
    case "fix_bug": {
      if (!state.activeProjectId) return { text: "Which project is this for? Use /project <name> first, or describe it as a new project." };
      if (harness.isActive(state.activeProjectId)) return { text: "A run is in progress on this project. Pause or wait for it to finish, then send the request again." };
      return startIntake(state, text, intent, hint);
    }
    case "question":
      return ask(state, text);
    case "status":
      return { text: state.activeProjectId ? statusText(state.activeProjectId) : "No project selected." };
    case "control": {
      const verb = controlFromText(text);
      if (!verb) return { text: "Say pause, resume, stop, retry or roll back." };
      return control(state, verb, requireProject(state));
    }
    case "plan_file":
      return importPlan(state, text);
  }
}

async function importPlan(state: ConversationState, raw: string): Promise<Reply> {
  const parsed = parsePlan(raw);
  if (!parsed.ok) return { text: `That plan has problems:\n${formatErrors(parsed.errors)}` };
  const existing = findProject(parsed.plan.project);
  const project = existing ?? (await createProject({ name: parsed.plan.project, description: parsed.plan.goal }));
  const plan = savePlanVersion(project.id, raw, { source: "imported" });
  state.activeProjectId = project.id;
  state.stage = "plan_review";
  state.planId = plan.id;
  return reviewReply(plan.id, `Imported your plan${existing ? ` as a new version for ${project.name}` : ` into a new project ${project.name}`}. Review the commands each phase will run:`);
}

async function ask(state: ConversationState, question: string): Promise<Reply> {
  const projectId = requireProject(state);
  const hits = await search(projectId, question, 8);
  if (!hits.length) return { text: "The project is not indexed yet (or has no matching code). Try /index first." };
  const answer = await answerQuestion(question, hits.map(hit => `File: ${hit.path}\n${hit.text}`).join("\n\n---\n\n"));
  return { text: answer };
}

const HELP = `Commands:
/new <description> — start a new project
/plan — current plan and phase states
/status — short status
/phase — current phase detail
/pause /resume /stop — control the run
/retry [hint] — retry the current phase
/skip — skip the blocked phase
/rollback — roll back to the last passing phase
/shot [route] — capture screenshots
/logs — last log lines
/engine <name> — switch engine
/project <name> — switch project
/projects — list projects
/ask <question> — ask about the codebase
/remember <text> — add a note to project memory
/index — re-index the project
/notify <all|phases|failures> — notification level
/budget — usage and caps
Or just describe what you want.`;

async function command(state: ConversationState, text: string): Promise<Reply> {
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/start":
    case "/help":
      return { text: HELP };
    case "/new":
      if (!arg) return { text: "Describe the project after /new, e.g. /new a recipe site with search." };
      return startIntake(state, arg, "new_project", null);
    case "/projects": {
      const projects = listProjects();
      return { text: projects.length ? projects.map(project => `${project.id === state.activeProjectId ? "▸" : "·"} ${project.name} (${project.engine})`).join("\n") : "No projects yet. Describe one to get started." };
    }
    case "/project": {
      const project = findProject(arg);
      if (!project) return { text: `No project called ${arg}. /projects lists them.` };
      state.activeProjectId = project.id;
      return { text: `Switched to ${project.name}.\n${statusText(project.id)}` };
    }
    case "/plan": {
      const projectId = requireProject(state);
      const detail = projectDetail(projectId);
      if (!detail.phases.length) return detail.latestPlan ? reviewReply(detail.latestPlan.id, "This plan is waiting for approval.") : { text: "No plan yet." };
      const icon: Record<string, string> = { passed: "✅", blocked: "⛔", skipped: "⏭", pending: "▫️", paused: "⏸", stopped: "⏹", interrupted: "⚠️" };
      return { text: detail.phases.map((phase, i) => `${icon[phase.status] ?? "🔄"} ${i + 1}. ${phase.name} — ${phase.status}${phase.attempts ? ` (${phase.attempts} attempts)` : ""}`).join("\n") };
    }
    case "/status":
      return { text: statusText(requireProject(state)) };
    case "/phase": {
      const projectId = requireProject(state);
      const phase = harness.currentPhase(projectId);
      if (!phase) return { text: "All phases are done." };
      const detail = projectDetail(projectId).phases.find(item => item.id === phase.id);
      return { text: `${phase.name} — ${phase.status}, ${phase.attempts} attempts\nBranch: ${phase.branch ?? "not created yet"}\nTasks:\n${detail?.tasks.map(task => `- ${task}`).join("\n")}\nChecks:\n${detail?.checks.map(check => `- ${check}`).join("\n")}\nDone when: ${detail?.doneWhen}` };
    }
    case "/pause":
      return control(state, "pause", requireProject(state));
    case "/resume":
    case "/continue":
      return control(state, "continue", requireProject(state));
    case "/stop":
      return control(state, "stop", requireProject(state));
    case "/retry":
      return control(state, "retry", requireProject(state), arg || undefined);
    case "/skip":
      return control(state, "skip", requireProject(state));
    case "/rollback":
      return control(state, "rollback", requireProject(state));
    case "/logs": {
      const projectId = requireProject(state);
      const rows = getDb().all<{ ts: string; title: string }>("SELECT ts, title FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 15", projectId).reverse();
      return { text: rows.map(row => `${row.ts.slice(11, 19)} ${row.title}`).join("\n") || "No events yet." };
    }
    case "/engine": {
      const projectId = requireProject(state);
      if (!engineNames().includes(arg)) return { text: `Engines: ${engineNames().join(", ")}` };
      updateProject(projectId, { engine: arg });
      return { text: `Engine for this project is now ${arg}.` };
    }
    case "/ask":
      if (!arg) return { text: "Usage: /ask where is login handled?" };
      return ask(state, arg);
    case "/remember": {
      const projectId = requireProject(state);
      if (!arg) return { text: "Usage: /remember <text>" };
      addNote({ projectId, title: arg.slice(0, 60), body: arg, source: "telegram" });
      await indexMemory(projectId, "note", arg);
      return { text: "Noted. Future prompts can use it." };
    }
    case "/index": {
      const projectId = requireProject(state);
      const project = getProject(projectId);
      const result = await indexProject(projectId, project.path);
      return { text: `Indexed ${result.files} files into ${result.chunks} chunks${result.embedded ? " with embeddings" : " (keyword search; embeddings unavailable)"}.` };
    }
    case "/notify": {
      if (!["all", "phases", "failures"].includes(arg)) return { text: "Usage: /notify all|phases|failures" };
      saveConfig({ telegram: { notificationLevel: arg as NotificationLevel } });
      return { text: `Notification level: ${arg}.` };
    }
    case "/budget": {
      const usage = usageToday();
      const budget = loadConfig().budget;
      return { text: `Today: ${usage.tokens.toLocaleString()} tokens across ${usage.runs} engine runs${usage.cost ? `, $${usage.cost.toFixed(2)}` : ""}.\nCaps: ${budget.phaseTokens.toLocaleString()} tokens/phase, ${budget.dailyTokens.toLocaleString()}/day, ${Math.round(budget.phaseWallClockS / 60)} min/phase.` };
    }
    case "/shot":
      return { text: `Capturing ${arg || "all preview routes"}…`, shot: { projectId: requireProject(state), route: arg || null } };
    default:
      return { text: `Unknown command ${cmd}. /help lists commands.` };
  }
}

export async function handleAction(channel: string, chatId: string, action: string, actor: string): Promise<Reply> {
  const state = loadState(channel, chatId);
  try {
    const reply = await routeAction(state, action, actor);
    saveState(channel, chatId, state);
    return reply;
  } catch (error) {
    saveState(channel, chatId, state);
    return { text: `Could not do that: ${redact((error as Error).message)}` };
  }
}

async function routeAction(state: ConversationState, action: string, actor: string): Promise<Reply> {
  const [verb, a, b] = action.split(":");
  const id = Number(a);
  switch (verb) {
    case "noop":
      return { text: "OK." };
    case "cancel":
      Object.assign(state, { ...emptyState(), activeProjectId: state.activeProjectId });
      return { text: "Cancelled. Nothing was run." };
    case "answer": {
      if (state.stage !== "clarifying") return { text: "That question has expired." };
      const question = state.questions![state.answers!.length];
      return recordAnswer(state, question.options[id] ?? question.default ?? "");
    }
    case "decide":
      if (state.stage !== "clarifying") return { text: "That question has expired." };
      return justDecide(state);
    case "intent":
      if (!state.request) return { text: "Send your request again." };
      return routeIntent(state, a as Intent, state.request, null);
    case "approve": {
      const plan = getPlan(id);
      await approvePlan(plan.id);
      state.stage = "idle";
      state.activeProjectId = plan.project_id;
      await harness.start(plan.project_id);
      return { text: `Plan v${plan.version} approved. Starting phase 1 on ${getProject(plan.project_id).engine}. I'll report back at each phase end.` };
    }
    case "edit":
      return { text: `Open the dashboard Plan editor to edit plan ${id}, or send me a full revised PLAN.md.` };
    case "improve": {
      const plan = getPlan(id);
      const improved = await improvePlan(plan.raw_md);
      const draft = savePlanVersion(plan.project_id, improved, { source: "suggested" });
      state.planId = draft.id;
      return reviewReply(draft.id, "Here is a version with stronger checks (your original is kept as the previous version):");
    }
    case "continue":
    case "resume":
    case "pause":
    case "stop":
    case "retry":
    case "skip":
    case "rollback":
    case "rollback_confirm":
      state.activeProjectId = id;
      return control(state, verb, id);
    case "retryhint":
      state.stage = "awaiting_hint";
      state.hintProjectId = id;
      return { text: "What should the agent do differently? Send the hint as a message." };
    case "addfeature":
      state.activeProjectId = id;
      state.stage = "awaiting_feature";
      return { text: "Describe the feature to add." };
    case "approval": {
      const row = decide(id, b === "yes" ? "approved" : "denied", actor);
      return { text: `${row.title}: ${row.status}.` };
    }
    default:
      return { text: "That button is no longer valid." };
  }
}
