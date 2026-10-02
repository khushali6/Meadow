import type { DiffFile } from "../core/git";
import { redact } from "../core/redact";
import { getLlm } from "../llm/client";
import type { PlanPhase } from "../planning/format";
import type { CheckOutcome } from "./verifier";

export function fallbackSummary(phase: PlanPhase, diff: DiffFile[], checks: CheckOutcome[]): string {
  const files = diff.slice(0, 6).map(file => file.path).join(", ");
  return `${phase.name}: ${phase.tasks.join("; ")}. Key files: ${files || "none"}. Checks passed: ${checks.map(check => check.label).join(", ")}.`;
}

export async function summarizePhase(phase: PlanPhase, diff: DiffFile[], checks: CheckOutcome[], engineReport: string): Promise<string> {
  try {
    const reply = await getLlm().chat([
      { role: "system", content: "You write short, factual engineering summaries. 3-5 sentences, no marketing, no lists longer than 5 items. Mention key files and decisions a later phase must know." },
      { role: "user", content: redact(`Phase: ${phase.name}\nTasks:\n${phase.tasks.map(task => `- ${task}`).join("\n")}\nDone when: ${phase.doneWhen}\n\nChanged files:\n${diff.slice(0, 40).map(file => `${file.kind} ${file.path} (+${file.additions} -${file.deletions})`).join("\n")}\n\nChecks passed:\n${checks.map(check => `- ${check.label}`).join("\n")}\n\nEngine's own report:\n${engineReport.slice(0, 3000)}`) },
    ], { maxTokens: 400 });
    return reply.text.trim().slice(0, 1500);
  } catch {
    return fallbackSummary(phase, diff, checks);
  }
}
