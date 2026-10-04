import { redact } from "../core/redact";
import { chatJson, getLlm, type ChatMessage } from "../llm/client";
import { loadConfig } from "../config";
import { runCursorPlanner } from "../llm/cursorPlanner";
import { formatErrors, MAX_PHASES, parsePlan, withServicesPhase, type Plan } from "../planning/format";
import { servicesSummary } from "../services/registry";
import { machineSummary as toolsSummary } from "../setup/toolbox";

/** Installed tools plus connected services, so plans only use what this computer can actually reach. */
async function machineSummary(): Promise<string> {
  return `${await toolsSummary()}\n${await servicesSummary()}`;
}

export const INTENTS = ["new_project", "add_feature", "fix_bug", "question", "status", "control", "plan_file"] as const;
export type Intent = (typeof INTENTS)[number];

export type Classification = { intent: Intent; confidence: number; needs_clarification: boolean; project_hint: string | null };

export type Question = { id: string; text: string; options: string[]; default: string | null };

/** Strip a single wrapping markdown code fence if present (```yaml ... ``` or ```md ... ```). */
export function stripCodeFence(text: string): string {
  return text.replace(/^```(?:yaml|markdown|md|yml)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
}

export function looksLikePlanFile(text: string) {
  const stripped = stripCodeFence(text);
  return /^---\s*\n[\s\S]*?\bphases\s*:/m.test(stripped);
}

export async function classify(text: string, projects: string[], activeProject: string | null): Promise<Classification> {
  if (looksLikePlanFile(text)) return { intent: "plan_file", confidence: 1, needs_clarification: false, project_hint: null };
  return chatJson(getLlm(), [
    { role: "system", content: `You classify requests sent to Meadow, a local agent that builds software projects phase by phase.
Reply with JSON only: {"intent": one of ${INTENTS.join("|")}, "confidence": 0..1, "needs_clarification": boolean, "project_hint": string|null}.

Intent rules:
- new_project: the user wants to build something that is clearly a DIFFERENT product from any existing project (different name, domain, or product idea). When in doubt between new_project and add_feature, prefer new_project if the request sounds like a standalone product.
- add_feature: the request explicitly mentions an existing project name, OR clearly adds/changes one specific behaviour in the active project.
- fix_bug: something in an existing project is broken or not working.
- question: asks about how the code works.
- status: asks about progress, what's done, what's running.
- control: pause/resume/stop/continue/rollback/retry instructions.

IMPORTANT: If there is an active project but the user's request describes a completely different product (different domain, different product name, completely unrelated feature set), classify it as new_project, not add_feature.

project_hint: the matching existing project name (only for add_feature/fix_bug/question), or a short kebab-case name suggestion for a new project (for new_project). Null for control/status.` },
    { role: "user", content: `Existing projects: ${projects.join(", ") || "none"}\nActive project: ${activeProject ?? "none"}\n\nRequest:\n${redact(text).slice(0, 4000)}` },
  ], value => {
    const v = value as Partial<Classification>;
    if (!v.intent || !INTENTS.includes(v.intent)) throw new Error(`intent must be one of ${INTENTS.join(", ")}`);
    return { intent: v.intent, confidence: Math.max(0, Math.min(1, Number(v.confidence ?? 0))), needs_clarification: Boolean(v.needs_clarification), project_hint: typeof v.project_hint === "string" && v.project_hint.trim() ? v.project_hint.trim() : null };
  }, { maxTokens: 300 });
}

export async function clarifyQuestions(request: string, kind: Intent, context: string): Promise<Question[]> {
  return chatJson(getLlm(), [
    { role: "system", content: `You prepare at most 5 short clarifying questions before planning a software ${kind === "new_project" ? "project" : kind === "fix_bug" ? "bug fix" : "feature"}.
Only ask what changes the plan: stack (only if none is detectable), must-have features, whether auth is needed, data source, deploy target, and for bugs the expected vs actual behaviour.
Prefer questions the user can answer with one tap: give 2-4 short options and a sensible default (the first option should be your recommendation).
Ask nothing that the request or project context already answers. Fewer is better; zero is fine.
Reply with JSON only: {"questions":[{"id":"stack","text":"Use Next.js + SQLite?","options":["Yes","Use something else"],"default":"Yes"}]}` },
    { role: "user", content: `Request:\n${redact(request)}\n\nProject context:\n${context.slice(0, 6000)}` },
  ], value => {
    const v = value as { questions?: Array<Partial<Question>> };
    if (!Array.isArray(v.questions)) throw new Error("questions must be an array");
    return v.questions.slice(0, 5).filter(q => typeof q.text === "string" && q.text.trim()).map((q, i) => ({
      id: String(q.id ?? `q${i + 1}`),
      text: String(q.text).trim(),
      options: Array.isArray(q.options) ? q.options.map(String).slice(0, 4) : [],
      default: typeof q.default === "string" ? q.default : Array.isArray(q.options) && q.options.length ? String(q.options[0]) : null,
    }));
  }, { maxTokens: 800 });
}

export const SPEC_TEMPLATE = `# <Project name>
## Goal
## Who it is for
## Must have
## Nice to have
## Constraints (stack, free-only, style)
## Out of scope
## Assumptions (made without asking)
## Open questions`;

export async function buildSpec(input: { request: string; answers: Array<{ question: string; answer: string; assumed: boolean }>; context: string; projectName: string; existingSpec?: string | null }): Promise<string> {
  const system = `You write SPEC.md files for small software projects. Use exactly this structure and headings:\n\n${SPEC_TEMPLATE}\n\nRules: concise bullet points; free and local services only unless the user asked otherwise; every answer marked "assumed" must appear under "Assumptions (made without asking)". Reply with the Markdown only.`;
  const user = redact(`Project name: ${input.projectName}\n\nRequest:\n${input.request}\n\nAnswers:\n${input.answers.map(a => `- ${a.question}: ${a.answer}${a.assumed ? " (assumed)" : ""}`).join("\n") || "- none"}\n\nProject context:\n${input.context.slice(0, 5000)}${input.existingSpec ? `\n\nExisting SPEC.md (extend it, keep what still applies):\n${input.existingSpec.slice(0, 4000)}` : ""}`);
  let text: string;
  if (useCursorPlanner()) {
    const result = await runCursorPlanner(`${system}\n\n---\n\n${user}`);
    text = result.ok ? result.text : (await getLlm().chat([{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: 1800 })).text;
  } else {
    const reply = await getLlm().chat([{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: 1800 });
    text = reply.text;
  }
  text = text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
  return text.startsWith("#") ? text : `# ${input.projectName}\n\n${text}`;
}

const PLAN_FORMAT = `---
project: bakery-site
goal: Online ordering site for a neighborhood bakery
stack: [nextjs, typescript, sqlite]
constraints:
  - Do not add paid services
services: [supabase]          # only hosted services the app truly needs; omit otherwise
env:                          # only variables the app reads at runtime (API keys, base URLs); names only, never values
  required:
    - STRIPE_SECRET_KEY: "Stripe dashboard → Developers → API keys"
  optional:
    - SENTRY_DSN: "Error reporting; the app works without it"
preview:                      # only for web apps; omit for CLIs/libraries
  command: npm run dev
  url: http://localhost:3000
  ready_timeout: 90
  routes: ["/", "/menu"]
phases:
  - id: 1
    name: Scaffold and base layout
    tasks:
      - Initialise the project with the chosen stack
      - Design system - a theme stylesheet with CSS variables (palette, fonts, type scale, spacing, radii), a reset, and styled base components (buttons, inputs, cards)
      - Create the shared layout and navigation with that design system, responsive down to 390px
    checks:
      - cmd: npm install && npm run build
      - file_exists: src/app/layout.tsx
    done_when: The site builds and shows a home page
  - id: 2
    name: Menu and cart
    depends_on: [1]
    agent: ui                 # optional: backend | ui | qa — the specialist the engine plays for this phase
    tasks:
      - Menu page with items from a JSON file
      - Cart with add/remove and totals, with unit tests
    checks:
      - cmd: npm test -- --run cart
      - http: /menu
    done_when: A user can add items to a cart and see the total
---

# Notes for humans (optional free text)`;

const PLAN_RULES = `Rules:
- Output a complete PLAN.md: YAML front-matter between --- lines, then optional notes. No code fences around it.
- 2-6 phases for a simple project; up to ${MAX_PHASES} for a complex one (several services, auth, database, payments, admin areas). Each phase is a coherent, independently verifiable step.
- services: list only hosted services the app truly needs, and only ones shown under "Connected services" (supabase for a hosted Postgres database/auth/storage, docker for containers). Otherwise use local tools (SQLite, files). Meadow adds a "Connect services" phase first by itself; don't write one, and don't create cloud resources in your tasks. Never use github in services; Meadow creates and pushes the repository.
- Phases after services may read SUPABASE_URL and SUPABASE_ANON_KEY from .env.local at runtime; checks must not need the network unless the app does.
- env: list every variable the app reads at runtime that the user must supply (third-party API keys, model endpoints), each with a short hint on where to get it. Never write values. Meadow pauses before phase 1 until required ones are filled in .env.local. The app must still start and show a clear "not configured" message when one is missing, and checks/tests must never need the real values (mock the external API in tests).
- agent: optionally give each phase a specialist role. backend for server/API/data work, ui for screens and styling, qa for a phase that writes and runs tests across real user flows. Complex projects should end with a qa phase.
- Phases that change the UI of a web app with a preview block are reviewed in a real browser at desktop and phone width after their checks pass; set ui_gate: false only for a phase that intentionally ships no styling yet.

- EVERY phase needs at least one runnable check. Check types: "cmd" (shell command, exit 0 = pass, optional expect_regex), "file_exists" (relative path), "http" (route on the preview URL returning 200; needs a preview block).
- Prefer real build/test commands. If a phase adds behaviour, its tasks must include writing tests and its checks must run them.
- Checks run non-interactively with CI=1: never use watch modes or commands that wait for input; dev servers are started by Meadow from the preview block, not in checks.
- The first phase must install dependencies as part of a check (e.g. "npm install && npm run build") because the repo starts empty.
- Use only free, local tools and services.
- Checks and the preview command may only use tools listed under "Tools installed"; pick the stack and package manager from those. If the project already has a lockfile, use its package manager.
- depends_on must reference earlier phase ids and form no cycles.
- preview.url must be http://localhost:<port>.
- Web apps must look premium, not like browser defaults: the first phase sets up the design system (theme stylesheet with design tokens, deliberate fonts, reset, styled base components, page layout), and every phase that adds screens includes a task for their designed empty, error and loading states and their phone layout. Never write constraints like "no styling" or "minimal CSS".`;

async function planLoop(messages: ChatMessage[], accept: (plan: Plan, raw: string) => string | null): Promise<string> {
  let conversation = messages;
  let lastErrors = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await getLlm().chat(conversation, { maxTokens: 4000, temperature: 0.1 });
    const raw = reply.text.replace(/^```(?:markdown|md|yaml)?\s*\n/i, "").replace(/\n```\s*$/, "").trim() + "\n";
    const parsed = parsePlan(raw);
    const extra = parsed.ok ? accept(parsed.plan, raw) : null;
    if (parsed.ok && !extra) return raw;
    lastErrors = parsed.ok ? extra! : formatErrors(parsed.errors);
    conversation = [...messages, { role: "assistant", content: raw }, { role: "user", content: `The plan is invalid:\n${lastErrors}\n\nReply with the full corrected PLAN.md only.` }];
  }
  throw new Error(`The planner could not produce a valid plan after 3 attempts:\n${lastErrors}`);
}

/**
 * Like planLoop but calls the Cursor CLI in read-only mode (ask) instead of the local LLM.
 * Cursor gets the full system + user prompt as one string; its response is validated the same way.
 */
async function cursorPlanLoop(systemPrompt: string, userPrompt: string, accept: (plan: Plan, raw: string) => string | null): Promise<string> {
  let lastErrors = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const fixNote = lastErrors ? `\n\nThe previous attempt was invalid:\n${lastErrors}\n\nReply with the full corrected PLAN.md only.` : "";
    const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}${fixNote}`;
    const result = await runCursorPlanner(fullPrompt);
    if (!result.ok) throw new Error(`Cursor planner failed: ${result.error ?? "no output"}`);
    const raw = result.text.replace(/^```(?:markdown|md|yaml)?\s*\n/i, "").replace(/\n```\s*$/, "").trim() + "\n";
    const parsed = parsePlan(raw);
    const extra = parsed.ok ? accept(parsed.plan, raw) : null;
    if (parsed.ok && !extra) return raw;
    lastErrors = parsed.ok ? extra! : formatErrors(parsed.errors);
  }
  throw new Error(`The Cursor planner could not produce a valid plan after 3 attempts:\n${lastErrors}`);
}

/** Whether to use Cursor for planning (spec + plan) or the local LLM. Disabled in test environments. */
function useCursorPlanner(): boolean {
  if (process.env.VITEST || process.env.CI) return false;
  return (loadConfig().llm.plannerEngine ?? "engine") === "engine";
}

export async function generatePlan(input: { spec: string; projectName: string; context: string }): Promise<string> {
  const system = `You are Meadow's planner. Turn a SPEC.md into a PLAN.md that a coding agent will execute phase by phase. Format example:\n\n${PLAN_FORMAT}\n\n${PLAN_RULES}`;
  const user = redact(`project: ${input.projectName}\n\n${await machineSummary()}\n\nSPEC.md:\n${input.spec}\n\nProject context:\n${input.context.slice(0, 4000)}`);
  const accept = (plan: Plan): string | null => plan.project !== input.projectName ? `project must be "${input.projectName}"` : plan.phases.length > MAX_PHASES ? `Use at most ${MAX_PHASES} phases; merge related steps.` : null;
  if (useCursorPlanner()) {
    try {
      return withServicesPhase(await cursorPlanLoop(system, user, accept));
    } catch (error) {
      // cursor-agent not available or timed out: fall back to the local LLM so the user always gets a plan.
      const msg = (error as Error).message ?? "";
      if (!msg.includes("cursor-agent not found") && !msg.includes("timed out") && !msg.includes("failed:")) throw error;
    }
  }
  // Local LLM path: auto-improve the plan's checks before presenting it (skip in test environments).
  const raw = await planLoop([{ role: "system", content: system }, { role: "user", content: user }], accept);
  if (!process.env.VITEST && !process.env.CI) {
    try {
      const improved = await improvePlan(raw);
      return withServicesPhase(improved);
    } catch {
      // Improvement failed (LLM unavailable, invalid output, etc.); the validated plan is good enough.
    }
  }
  return withServicesPhase(raw);
}

/** Append phases for a feature or bug to an existing plan without rewriting finished phases. */
export async function appendPhases(input: { existingPlan: string; request: string; kind: "add_feature" | "fix_bug"; spec: string | null; context: string }): Promise<string> {
  const existing = parsePlan(input.existingPlan);
  if (!existing.ok) throw new Error("The current plan is invalid; fix it before adding work.");
  const keep = existing.plan.phases.map(phase => `${phase.id}:${phase.name}`);
  const keepBlock = keep.map((label, i) => `  Phase ${i + 1} (KEEP EXACTLY AS-IS): ${label}`).join("\n");
  return withServicesPhase(await planLoop([
    { role: "system", content: `You are Meadow's planner. Extend an existing PLAN.md by APPENDING 1–2 NEW phases at the end.

CRITICAL RULE: You MUST copy every existing phase into the output EXACTLY as it appears in the input — same id, same name, same tasks, same checks, same depends_on. Do NOT rewrite, rename, merge or remove any existing phase. Only ADD new phases with new ids after the last existing phase.

${input.kind === "fix_bug" ? 'Bug fix: the first new phase\'s first task must be "Reproduce the bug with a failing automated test", and its checks must run that test.' : ""}
Format example:\n\n${PLAN_FORMAT}\n\n${PLAN_RULES}` },
    { role: "user", content: redact(`Request:\n${input.request}\n\n${await machineSummary()}\n\nExisting phases that MUST appear unchanged in your output:\n${keepBlock}\n\nFull current PLAN.md (copy all existing phases verbatim, then append new ones):\n${input.existingPlan}\n\n${input.spec ? `SPEC.md:\n${input.spec.slice(0, 3000)}\n\n` : ""}Project context:\n${input.context.slice(0, 4000)}`) },
  ], plan => {
    const ids = plan.phases.map(phase => `${phase.id}:${phase.name}`);
    const missing = keep.filter(item => !ids.includes(item));
    if (missing.length) return `Existing phases must be kept unchanged; missing: ${missing.join(", ")}`;
    if (plan.phases.length <= keep.length) return "Append at least one new phase for the request.";
    return null;
  }));
}

/** Suggest missing checks for a user-provided plan. Returns a new draft; the user's file is never edited silently. */
export async function improvePlan(raw: string): Promise<string> {
  return planLoop([
    { role: "system", content: `Improve the checks of a user's PLAN.md: add missing build/test checks where a phase only checks file existence or has weak checks. Do not change goals, phase names, ids, tasks or order. ${PLAN_RULES}` },
    { role: "user", content: `${await machineSummary()}\n\n${raw}` },
  ], () => null);
}

export async function answerQuestion(question: string, snippets: string): Promise<string> {
  const reply = await getLlm().chat([
    { role: "system", content: "Answer questions about a codebase using only the provided snippets. Cite file paths in backticks. If the snippets do not contain the answer, say so briefly." },
    { role: "user", content: redact(`Question: ${question}\n\nSnippets:\n${snippets.slice(0, 12000)}`) },
  ], { maxTokens: 700 });
  return reply.text.trim();
}

export async function projectNameFor(request: string, hint: string | null): Promise<string> {
  if (hint) return hint;
  const reply = await getLlm().chat([
    { role: "system", content: "Reply with only a short kebab-case project name (2-4 words, lowercase, dashes). No punctuation or explanation." },
    { role: "user", content: request.slice(0, 1000) },
  ], { maxTokens: 20 });
  return reply.text.trim().split(/\s+/)[0];
}
