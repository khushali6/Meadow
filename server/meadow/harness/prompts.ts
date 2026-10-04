import fs from "node:fs";
import path from "node:path";
import { homePath } from "../config";
import { redact, tail } from "../core/redact";
import { untrusted, UNTRUSTED_RULE } from "../brief/brief";
import { checkLabel, type AgentRole, type Check, type Plan, type PlanPhase } from "../planning/format";
import { POLICY_PROMPT } from "../guard/policy";
import { E2E_FILE, E2E_FORMAT } from "../visual/e2e";
import { designSection } from "./design";

export const PHASE_TEMPLATE = `# Role
You are working inside an existing git repository on a branch dedicated to this phase.
Work only inside this repository. Do not touch files outside it.
{agent_role}

# Project goal
{goal}

# Constraints
{constraints}
{project_rules}
{design_standard}

# Project brief (whole plan and current state)
{project_brief}

# What has been done so far
{previous_phase_summaries}

# This phase: {phase_name}
Tasks:
{tasks_as_checklist}

Done when: {done_when}

# Relevant existing code
{rag_snippets_or_file_list}

# Acceptance checks
These must all pass before you finish:
{checks_as_commands}

# Rules
1. Make the smallest set of changes that completes the tasks.
2. Run the acceptance checks yourself. If one fails, fix it and run it again.
3. Do not modify the plan, the spec, or Meadow's configuration (PLAN.md, SPEC.md, .meadow/).
4. Do not install anything outside the project (no global installs).
5. Do not delete files you did not create unless a task requires it.
6. Never write secrets, API keys or tokens into files.
7. Stay within this phase. Later phases in the roadmap are context, not work for now.
8. {untrusted_rule}
9. When finished, reply with: files changed, checks run with results, anything left undone.
{guard_feedback}`;

export const FIX_TEMPLATE = `# Context
Same repository and branch. The previous attempt did not pass verification.
{agent_role}
Phase: {phase_name} (attempt {attempt})
Tasks:
{tasks_as_checklist}
Done when: {done_when}

# Project brief
{project_brief}

# Failing check
Command: {command}
Exit code: {exit_code}
Output (last {n} lines):
{output_tail}

# Instructions
Fix the cause of this failure. Do not weaken, skip or delete the check.
{untrusted_rule}
Run the failing command again and confirm it passes.
Then run the remaining acceptance checks:
{other_checks}
{hint}
{design_standard}
{guard_feedback}`;

export function loadTemplate(name: "phase" | "fix", projectPath?: string): string {
  const candidates = [projectPath ? path.join(projectPath, ".meadow", "templates", `${name}.md`) : null, homePath("templates", `${name}.md`)].filter(Boolean) as string[];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf8");
      if (text.trim()) return text;
    } catch {
      // Fall through to the built-in template.
    }
  }
  return name === "phase" ? PHASE_TEMPLATE : FIX_TEMPLATE;
}

export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (key in values ? values[key] : whole)).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function checkAsCommand(check: Check, previewUrl?: string): string {
  if (check.kind === "cmd") return `- \`${check.cmd}\`${check.expectRegex ? ` (output must match /${check.expectRegex}/)` : ""}`;
  if (check.kind === "file_exists") return `- file exists: ${check.path}`;
  const url = check.path.startsWith("/") && previewUrl ? new URL(check.path, previewUrl).toString() : check.path;
  return `- GET ${url} returns ${check.expectStatus} (start the dev server with the preview command to test it)`;
}

const AGENT_ROLE_TEXT: Record<AgentRole, string> = {
  backend: `You are the backend engineer on this team. You own the server, API, data model, validation and error handling.
- Every endpoint validates its input, returns JSON with correct status codes, and never leaks stack traces or secrets.
- Every endpoint gets tests for the happy path and for invalid input.
- Read configuration from environment variables; when one is missing, fail with a clear message instead of crashing.
- Don't restyle the UI; only wire it to your API where the tasks need it.`,
  ui: `You are the UI engineer on this team. You own the screens, components, styling and motion.
- Follow the design standard exactly: tokens only, no stray values, every state designed (empty, loading, error, success).
- Responsive at 390px, 768px and 1280px; nothing scrolls sideways. Hover, focus-visible, active and disabled states on every control.
- Don't change API contracts. If a screen needs data the API doesn't give, add the smallest endpoint change with a test.
- Meadow reviews the running app in a browser at desktop and phone width after this phase; unstyled or broken screens fail it.`,
  qa: `You are the QA engineer on this team. You find bugs by using the app the way a real user would, then fix them.
- Write tests that exercise real flows: unit tests for logic, API tests for every endpoint (including invalid input), and browser cases in ${E2E_FILE}.
- Cover the happy path, empty states, validation errors, missing configuration and the phone layout.
- When a test exposes a bug, fix the app. Never weaken, skip or delete a test to make it pass.

${E2E_FORMAT}`,
};

function agentRole(phase: PlanPhase): string {
  return phase.agent ? `\n# Your role on the team\n${AGENT_ROLE_TEXT[phase.agent]}` : "";
}

function envConstraint(plan: Plan): string[] {
  const all = [...(plan.env?.required ?? []), ...(plan.env?.optional ?? [])];
  if (!all.length) return [];
  return [`Environment variables (read at runtime from .env.local, which the user fills in; never print, cat, grep or commit it, and never hardcode values): ${all.map(item => item.name).join(", ")}. List the same names without values in .env.example. When a value is missing, the app must start and show a clear "not configured" message instead of crashing; tests must not need the real values.`];
}

export type PhasePromptInput = {
  plan: Plan;
  phase: PlanPhase;
  projectPath: string;
  projectRules: string;
  previousSummaries: Array<{ name: string; summary: string }>;
  context: string;
  brief?: string;
  guardFeedback?: string;
};

export function compilePhasePrompt(input: PhasePromptInput): string {
  const { plan, phase } = input;
  const constraints = [
    ...plan.constraints,
    ...(plan.stack.length ? [`Stack: ${plan.stack.join(", ")}`] : []),
    ...(plan.services.length ? [`Services: ${plan.services.join(", ")}. Get them only through the Meadow tool request_cloud_resource; settings live in .env.local (never print or commit it).`] : []),
    ...envConstraint(plan),
  ];
  return redact(render(loadTemplate("phase", input.projectPath), {
    agent_role: agentRole(phase),
    goal: plan.goal,
    constraints: constraints.length ? constraints.map(item => `- ${item}`).join("\n") : "- None beyond the rules below.",
    project_rules: input.projectRules.trim() ? `\nProject rules:\n${input.projectRules.trim()}` : "",
    design_standard: designHeading(plan, input.projectPath),
    project_brief: input.brief?.trim() || "No brief available.",
    untrusted_rule: UNTRUSTED_RULE,
    previous_phase_summaries: input.previousSummaries.length ? input.previousSummaries.map(item => `- ${item.name}: ${item.summary}`).join("\n") : "Nothing yet. This is the first phase.",
    phase_name: phase.name,
    tasks_as_checklist: phase.tasks.map(task => `- [ ] ${task}`).join("\n"),
    done_when: phase.doneWhen,
    rag_snippets_or_file_list: input.context.trim() ? untrusted(input.context.trim(), "repository") : "The repository is empty or has no relevant files yet.",
    checks_as_commands: phase.checks.map(check => checkAsCommand(check, plan.preview?.url)).join("\n") + (plan.preview ? `\n\nPreview command: \`${plan.preview.command}\` (serves ${plan.preview.url})` : ""),
    guard_feedback: input.guardFeedback ? `\n# Corrections from the previous attempt\n${input.guardFeedback}` : "",
  }));
}

export type FixPromptInput = {
  plan: Plan;
  phase: PlanPhase;
  projectPath: string;
  failing: { check: Check; exitCode: number | null; output: string };
  hint?: string;
  guardFeedback?: string;
  tailLines?: number;
  brief?: string;
  attempt?: { n: number; max: number };
};

export function compileFixPrompt(input: FixPromptInput): string {
  const n = input.tailLines ?? 60;
  const others = input.phase.checks.filter(check => check !== input.failing.check);
  return redact(render(loadTemplate("fix", input.projectPath), {
    agent_role: agentRole(input.phase),
    phase_name: input.phase.name,
    attempt: input.attempt ? `${input.attempt.n} of ${input.attempt.max}` : "retry",
    tasks_as_checklist: input.phase.tasks.map(task => `- [ ] ${task}`).join("\n"),
    project_brief: input.brief?.trim() || "No brief available.",
    untrusted_rule: UNTRUSTED_RULE,
    done_when: input.phase.doneWhen,
    command: checkLabel(input.failing.check),
    exit_code: input.failing.exitCode === null ? "none (timed out or not a command)" : String(input.failing.exitCode),
    n: String(n),
    output_tail: untrusted(tail(input.failing.output, n), "check output"),
    other_checks: others.length ? others.map(check => checkAsCommand(check, input.plan.preview?.url)).join("\n") : "- (no other checks)",
    hint: input.hint ? `\n# Hint from the user\n${input.hint}` : "",
    design_standard: designHeading(input.plan, input.projectPath),
    guard_feedback: input.guardFeedback ? `\n# Corrections\n${input.guardFeedback}` : "",
  }));
}

function designHeading(plan: Plan, projectPath: string): string {
  const brief = designSection(plan, projectPath);
  return brief ? `\n# Design standard (required for every screen you touch)\n${brief}` : "";
}

/** Language/stack-specific coding standards injected into every phase prompt. */
function stackGuidance(plan: Plan): string {
  const stack = plan.stack.map(s => s.toLowerCase());
  const lines: string[] = [];

  if (stack.some(s => /^python/.test(s) || ["fastapi", "django", "flask", "pytorch", "sklearn", "pandas"].includes(s))) {
    lines.push("Python: type-annotate everything, use async/await where the framework supports it, write pytest tests (not unittest), manage deps with pyproject.toml (not setup.py), never use wildcard imports.");
  }
  if (stack.some(s => ["rust"].includes(s))) {
    lines.push("Rust: run `cargo clippy -- -D warnings` and `cargo test` before finishing. Prefer `thiserror` for error types. No `unwrap()` in library code.");
  }
  if (stack.some(s => ["go", "golang"].includes(s))) {
    lines.push("Go: run `go vet ./...` and `go test ./...`. Use `errors.Is`/`errors.As` for error handling. Every exported symbol needs a comment.");
  }
  if (stack.some(s => ["java", "spring", "kotlin"].includes(s))) {
    lines.push("JVM: compile with `./mvnw verify` or `./gradlew build`. Tests via JUnit 5. No checked exceptions swallowed silently.");
  }
  if (stack.some(s => ["swift", "swiftui", "xcode"].includes(s))) {
    lines.push("Swift: use `xcodebuild test` to verify. All async work via Swift Concurrency (async/await), not GCD. Run SwiftLint.");
  }
  if (stack.some(s => ["dbt", "spark", "airflow", "prefect", "dagster"].includes(s))) {
    lines.push("Data engineering: every transformation must be idempotent. Store intermediate results as Parquet where possible. Add data quality tests (not_null, unique) for every primary key.");
  }
  if (stack.some(s => ["docker", "kubernetes", "terraform", "ansible"].includes(s))) {
    lines.push("Infrastructure: use multi-stage Docker builds to minimise image size. Never embed secrets in images or Terraform state. Apply the principle of least privilege on IAM/RBAC.");
  }
  if (!lines.length) {
    lines.push("Follow the language's idiomatic style and run its standard linter/formatter before finishing each phase.");
  }

  return lines.map(l => `- ${l}`).join("\n");
}

export function rulesFileContent(plan: Plan, projectRules: string, projectPath = ""): string {
  const design = projectPath ? designSection(plan, projectPath) : "";
  return [
    `Project goal: ${plan.goal}`,
    ...plan.constraints.map(item => `- ${item}`),
    projectRules.trim(),
    "- Never edit PLAN.md, SPEC.md or anything under .meadow/.",
    "- Never install packages globally or write outside this repository.",
    `\nStack guidance:\n${stackGuidance(plan)}`,
    design ? `\nDesign standard for every screen:\n${design}` : "",
    POLICY_PROMPT,
  ].filter(Boolean).join("\n");
}
