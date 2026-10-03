import { loadConfig } from "../config";
import { getDb } from "../core/db";
import * as git from "../core/git";
import { checkLabel, type Check, type Plan, type PlanPhase } from "../planning/format";
import { phasesFor, type PhaseRow } from "../projects";
import { findBrowser } from "../visual/browser";
import { E2E_FILE, E2E_FORMAT, failureReport, loadScenarios, runEndToEnd, scenarioFile, type CaseResult } from "../visual/e2e";
import { detectLaunch, launchApp, type LaunchSpec } from "../visual/launch";
import type { PreviewHandle } from "../visual/preview";
import type { CheckOutcome } from "./verifier";
import { isWebPlan } from "./design";

export const ACCEPTANCE_KEY = "meadow-e2e";
export const ACCEPTANCE_NAME = "End-to-end tests in a browser";
export const E2E_CHECK: Check = { kind: "cmd", cmd: `End-to-end browser tests (${E2E_FILE})` };

/** The built-in last phase: the engine writes browser test cases, Meadow runs them, failures go back to the engine. */
export function acceptancePhase(plan: Plan): PlanPhase {
  const seen = new Set<string>();
  const checks = plan.phases.flatMap(phase => phase.checks).filter(check => check.kind !== "http").filter(check => {
    const label = checkLabel(check);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
  return {
    id: ACCEPTANCE_KEY,
    name: ACCEPTANCE_NAME,
    dependsOn: [],
    tasks: [
      `Write ${E2E_FILE} at the project root with one test case per main user flow of the goal ("${plan.goal}"), including at least one case for invalid input. Use the exact visible labels and button texts from the UI. If it exists, keep every case and add missing ones.`,
      E2E_FORMAT,
      "Start the app exactly as a user would (the dev or start script, nothing overridden) and use it in a browser yourself. Fix every error: crashes, console errors, failed API calls, API calls answered by an HTML page, and error messages shown on screen.",
      "The app must run on any machine: don't depend on a port another program may own (fall back to a free port, or have the client discover the API port instead of hardcoding it), and keep the dev proxy and the API server on the same port setting.",
      ...(loadConfig().harness.design && isWebPlan(plan) ? ["Meadow also checks the design in the browser at desktop and phone width: a page that still looks like browser defaults (default font, unstyled buttons or inputs, no hierarchy, no hover or focus styles, sideways scrolling on a phone) fails. Polish every screen to the design standard."] : []),
      "Keep every existing check passing.",
    ],
    checks: checks.length ? checks : [{ kind: "file_exists", path: E2E_FILE }],
    doneWhen: `Every case in ${E2E_FILE} passes in a real browser with no errors, and every earlier check still passes.`,
  };
}

export function acceptanceRow(planId: number): PhaseRow | undefined {
  return phasesFor(planId).find(row => row.phase_key === ACCEPTANCE_KEY);
}

/** Creates the acceptance row once per plan, and resets it when the code moved on since it last passed. */
export async function ensureAcceptanceRow(planId: number, projectPath: string, baseBranch: string): Promise<PhaseRow> {
  const existing = acceptanceRow(planId);
  if (!existing) {
    const id = getDb().insert("phases", { plan_id: planId, idx: 1000, phase_key: ACCEPTANCE_KEY, name: ACCEPTANCE_NAME, status: "pending", attempts: 0 });
    return phasesFor(planId).find(row => row.id === id)!;
  }
  if (existing.status === "passed" && existing.commit_sha) {
    const head = await git.git(projectPath, "rev-parse", baseBranch).then(out => out.trim()).catch(() => "");
    if (head && head !== existing.commit_sha) {
      getDb().update("phases", existing.id, { status: "pending", attempts: 0, branch: null, started_at: null, finished_at: null });
      return acceptanceRow(planId)!;
    }
  }
  return existing;
}

/** Whether this project can be tested in a browser here; the reason when not. */
export async function acceptanceApplies(projectPath: string, plan: Plan): Promise<{ spec: LaunchSpec; browser: string } | { reason: string }> {
  const spec = await detectLaunch(projectPath, plan);
  if (!spec) return { reason: "This project has no web page to test (no preview block, dev script, Python web app or index.html)." };
  const browser = await findBrowser();
  if (!browser) return { reason: "No browser found for end-to-end tests. Install Google Chrome, Microsoft Edge or Chromium, or set MEADOW_BROWSER." };
  return { spec, browser };
}

export type AcceptanceResult = { outcome: CheckOutcome; results: CaseResult[]; signature: string; runHow: string | null; url: string | null };

const outcome = (passed: boolean, output: string, started: number): CheckOutcome => ({ check: E2E_CHECK, label: checkLabel(E2E_CHECK), passed, exitCode: passed ? 0 : 1, output, durationMs: Date.now() - started });

function committedCaseCount(projectPath: string, baseSha: string): Promise<number> {
  return git.git(projectPath, "show", `${baseSha}:${E2E_FILE}`).then(text => {
    const parsed = scenarioFile.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.cases.length : 0;
  }).catch(() => 0);
}

/** Runs the app and every test case. The outcome fails with everything the engine needs to fix it. */
export async function runAcceptance(input: { projectPath: string; projectId: number; phaseId: number; plan: Plan; baseSha: string; folder: string; onProgress: (title: string, detail: string) => void }): Promise<AcceptanceResult> {
  const started = Date.now();
  const fail = (output: string, signature: string, extra: Partial<AcceptanceResult> = {}): AcceptanceResult => ({ outcome: outcome(false, output, started), results: [], signature, runHow: null, url: null, ...extra });
  const { cases, problem } = loadScenarios(input.projectPath);
  if (problem) return fail(`${problem}\n\n${E2E_FORMAT}`, `file:${problem}`);
  const before = await committedCaseCount(input.projectPath, input.baseSha);
  if (cases.length < before) return fail(`${E2E_FILE} had ${before} test cases and now has ${cases.length}. Don't remove test cases; fix the app so they pass.`, "cases-removed");
  const applies = await acceptanceApplies(input.projectPath, input.plan);
  if ("reason" in applies) return fail(applies.reason, `applies:${applies.reason}`);
  let handle: PreviewHandle | null = null;
  try {
    input.onProgress("Starting the app for end-to-end tests", applies.spec.how);
    try {
      handle = await launchApp(applies.spec, input.projectPath, detail => input.onProgress(detail, ""));
    } catch (error) {
      const message = (error as Error).message;
      return fail(`The app did not start with \`${applies.spec.how}\`, the way a user would run it:\n${message.slice(-3000)}`, `launch:${message.split("\n")[0]}`, { runHow: applies.spec.how });
    }
    input.onProgress(`Running ${cases.length + 1} end-to-end test cases`, handle.url);
    const results = await runEndToEnd({ browser: applies.browser, baseUrl: handle.url, cases, projectPath: input.projectPath, projectId: input.projectId, phaseId: input.phaseId, folder: input.folder, design: loadConfig().harness.design });
    const failing = results.filter(result => !result.passed);
    const common = { results, runHow: applies.spec.how, url: handle.url };
    if (!failing.length) return { outcome: outcome(true, `${results.length}/${results.length} end-to-end test cases passed`, started), signature: "", ...common };
    const report = failureReport(results, cases, { how: applies.spec.how, url: handle.url, appLog: handle.log().split("\n").slice(-25).join("\n") });
    const signature = failing.map(result => `${result.name}:${result.failure}`).join("|").replace(/\d+/g, "#");
    return { outcome: outcome(false, report, started), signature, ...common };
  } finally {
    handle?.stop();
  }
}
