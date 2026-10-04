import fs from "node:fs";
import { loadConfig } from "../config";
import { getDb, now } from "../core/db";
import { minimalEnv, runShell } from "../core/exec";
import { confine } from "../core/paths";
import { tail } from "../core/redact";
import { checkLabel, type Check } from "../planning/format";
import { findBrowser } from "../visual/browser";
import { E2E_FILE, E2E_FORMAT, failureReport, loadScenarios, runEndToEnd } from "../visual/e2e";

export type CheckOutcome = { check: Check; label: string; passed: boolean; exitCode: number | null; output: string; durationMs: number };

/** Runs the scenario cases under check.path against the running preview. */
async function runE2eCheck(check: Extract<Check, { kind: "e2e" }>, cwd: string, previewUrl: string | null, ctx: { projectId?: number; phaseId?: number | null }): Promise<CheckOutcome> {
  const label = checkLabel(check);
  const started = Date.now();
  const fail = (output: string): CheckOutcome => ({ check, label, passed: false, exitCode: 1, output, durationMs: Date.now() - started });
  if (!previewUrl) return fail("Browser tests need a running preview, but the preview server did not start.");
  const browser = await findBrowser();
  if (!browser) return { check, label, passed: true, exitCode: 0, output: "Skipped: no Chromium-based browser found for browser tests.", durationMs: 0 };
  const { cases, problem } = loadScenarios(cwd);
  if (problem) return fail(`${problem}\n\n${E2E_FORMAT}`);
  const selected = cases.filter(item => check.path === "/" || item.path === check.path || item.path.startsWith(`${check.path.replace(/\/$/, "")}/`) || item.steps.some(step => "goto" in step && step.goto.startsWith(check.path)));
  if (!selected.length) return fail(`${E2E_FILE} has no test cases for ${check.path}. Add cases whose "path" is ${check.path} covering its main flows and at least one invalid input.\n\n${E2E_FORMAT}`);
  const results = await runEndToEnd({ browser, baseUrl: previewUrl, cases: selected, projectPath: cwd, projectId: ctx.projectId ?? 0, phaseId: ctx.phaseId ?? null, folder: `e2e-check-${ctx.phaseId ?? "x"}-${check.path.replace(/[^a-z0-9]+/gi, "-") || "root"}` });
  const failing = results.filter(result => !result.passed);
  if (!failing.length) return { check, label, passed: true, exitCode: 0, output: `${results.length}/${results.length} browser test cases passed on ${check.path}`, durationMs: Date.now() - started };
  return fail(failureReport(results, selected, { how: "the plan's preview command", url: previewUrl, appLog: "" }));
}

export async function runCheck(check: Check, cwd: string, previewUrl: string | null, signal?: AbortSignal, ctx: { projectId?: number; phaseId?: number | null } = {}): Promise<CheckOutcome> {
  const label = checkLabel(check);
  const started = Date.now();
  if (check.kind === "e2e") return runE2eCheck(check, cwd, previewUrl, ctx);
  if (check.kind === "file_exists") {
    let exists = false;
    try {
      exists = fs.existsSync(confine(cwd, check.path));
    } catch (error) {
      return { check, label, passed: false, exitCode: null, output: (error as Error).message, durationMs: 0 };
    }
    return { check, label, passed: exists, exitCode: exists ? 0 : 1, output: exists ? `${check.path} exists` : `${check.path} does not exist`, durationMs: Date.now() - started };
  }
  if (check.kind === "http") {
    if (!previewUrl && check.path.startsWith("/")) return { check, label, passed: false, exitCode: null, output: "http check needs a running preview, but no preview is configured.", durationMs: 0 };
    const url = check.path.startsWith("/") ? new URL(check.path, previewUrl!).toString() : check.path;
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      const passed = response.status === check.expectStatus;
      return { check, label, passed, exitCode: passed ? 0 : 1, output: `GET ${url} → ${response.status}\n${body.slice(0, 1500)}`, durationMs: Date.now() - started };
    } catch (error) {
      return { check, label, passed: false, exitCode: null, output: `GET ${url} failed: ${(error as Error).message}`, durationMs: Date.now() - started };
    }
  }
  const timeoutS = check.timeoutS ?? loadConfig().harness.checkTimeoutS;
  const result = await runShell(check.cmd, { cwd, timeoutS, env: minimalEnv(), signal });
  let passed = result.exitCode === 0;
  let output = result.output;
  if (result.timedOut) output += `\n[meadow] check timed out after ${timeoutS}s`;
  if (passed && check.expectRegex && !new RegExp(check.expectRegex, "m").test(result.output)) {
    passed = false;
    output += `\n[meadow] output did not match /${check.expectRegex}/`;
  }
  return { check, label, passed, exitCode: result.exitCode, output, durationMs: result.durationMs };
}

/** The harness runs every check itself; the engine's claim that tests pass is never trusted. */
export async function verify(checks: Check[], options: { cwd: string; previewUrl: string | null; phaseId: number; runId: number | null; projectId?: number; signal?: AbortSignal; onResult?: (outcome: CheckOutcome) => void }): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    if (options.signal?.aborted) break;
    const outcome = await runCheck(check, options.cwd, options.previewUrl, options.signal, { projectId: options.projectId, phaseId: options.phaseId });
    getDb().insert("checks", {
      phase_id: options.phaseId,
      run_id: options.runId,
      label: outcome.label,
      command: outcome.label,
      exit_code: outcome.exitCode,
      passed: outcome.passed ? 1 : 0,
      output_tail: tail(outcome.output, 80),
      duration_ms: outcome.durationMs,
      ts: now(),
    });
    outcomes.push(outcome);
    options.onResult?.(outcome);
  }
  return outcomes;
}
