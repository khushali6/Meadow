import fs from "node:fs";
import path from "node:path";
import { homePath } from "../config";
import { redact, tail } from "../core/redact";
import { checkLabel, type Check, type Plan, type PlanPhase } from "../planning/format";

export const PHASE_TEMPLATE = `# Role
You are working inside an existing git repository on a branch dedicated to this phase.
Work only inside this repository. Do not touch files outside it.

# Project goal
{goal}

# Constraints
{constraints}
{project_rules}

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
7. When finished, reply with: files changed, checks run with results, anything left undone.
{guard_feedback}`;

export const FIX_TEMPLATE = `# Context
Same repository and branch. The previous attempt did not pass verification.
Phase: {phase_name}
Done when: {done_when}

# Failing check
Command: {command}
Exit code: {exit_code}
Output (last {n} lines):
{output_tail}

# Instructions
Fix the cause of this failure. Do not weaken, skip or delete the check.
Run the failing command again and confirm it passes.
Then run the remaining acceptance checks:
{other_checks}
{hint}
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

export type PhasePromptInput = {
  plan: Plan;
  phase: PlanPhase;
  projectPath: string;
  projectRules: string;
  previousSummaries: Array<{ name: string; summary: string }>;
  context: string;
  guardFeedback?: string;
};

export function compilePhasePrompt(input: PhasePromptInput): string {
  const { plan, phase } = input;
  const constraints = [...plan.constraints, ...(plan.stack.length ? [`Stack: ${plan.stack.join(", ")}`] : [])];
  return redact(render(loadTemplate("phase", input.projectPath), {
    goal: plan.goal,
    constraints: constraints.length ? constraints.map(item => `- ${item}`).join("\n") : "- None beyond the rules below.",
    project_rules: input.projectRules.trim() ? `\nProject rules:\n${input.projectRules.trim()}` : "",
    previous_phase_summaries: input.previousSummaries.length ? input.previousSummaries.map(item => `- ${item.name}: ${item.summary}`).join("\n") : "Nothing yet. This is the first phase.",
    phase_name: phase.name,
    tasks_as_checklist: phase.tasks.map(task => `- [ ] ${task}`).join("\n"),
    done_when: phase.doneWhen,
    rag_snippets_or_file_list: input.context.trim() || "The repository is empty or has no relevant files yet.",
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
};

export function compileFixPrompt(input: FixPromptInput): string {
  const n = input.tailLines ?? 60;
  const others = input.phase.checks.filter(check => check !== input.failing.check);
  return redact(render(loadTemplate("fix", input.projectPath), {
    phase_name: input.phase.name,
    done_when: input.phase.doneWhen,
    command: checkLabel(input.failing.check),
    exit_code: input.failing.exitCode === null ? "none (timed out or not a command)" : String(input.failing.exitCode),
    n: String(n),
    output_tail: "```\n" + tail(input.failing.output, n) + "\n```",
    other_checks: others.length ? others.map(check => checkAsCommand(check, input.plan.preview?.url)).join("\n") : "- (no other checks)",
    hint: input.hint ? `\n# Hint from the user\n${input.hint}` : "",
    guard_feedback: input.guardFeedback ? `\n# Corrections\n${input.guardFeedback}` : "",
  }));
}

export function rulesFileContent(plan: Plan, projectRules: string): string {
  return [
    `Project goal: ${plan.goal}`,
    ...plan.constraints.map(item => `- ${item}`),
    projectRules.trim(),
    "- Never edit PLAN.md, SPEC.md or anything under .meadow/.",
    "- Never install packages globally or write outside this repository.",
  ].filter(Boolean).join("\n");
}
