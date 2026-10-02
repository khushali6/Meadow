import { loadConfig } from "../config";
import { bus } from "../core/events";
import { minimalEnv, runShell } from "../core/exec";
import { tail } from "../core/redact";
import { getSetting, putSetting } from "../core/settings";
import type { Check } from "../planning/format";
import { getProject } from "../projects";
import { detectProject, type VerifyKind } from "./detect";

export type BaselineResult = { kind: VerifyKind; cmd: string; passed: boolean; exitCode: number | null; durationMs: number; output: string; missingTool?: boolean };
export type Baseline = { at: string; results: BaselineResult[] };

const ORDER: VerifyKind[] = ["typecheck", "lint", "test", "build"];

/** The shell couldn't find the program (POSIX 127, cmd.exe 9009 or its message): an install problem, not a code problem. */
export const isMissingTool = (exitCode: number | null, output: string) => exitCode === 127 || exitCode === 9009 || /command not found|is not recognized as an internal or external command|not found in PATH|No such file or directory.*\.venv/i.test(output);

export const baselineOf = (projectId: number) => getSetting<Baseline>(`baseline:${projectId}`);

/**
 * Runs the project's detected verification commands once, on the current tree. Only commands that pass here
 * are enforced after phases, so pre-existing failures (say, old lint errors) never block the agent.
 */
export async function runBaseline(projectId: number, onResult: (result: BaselineResult) => void = () => undefined): Promise<Baseline> {
  const project = getProject(projectId);
  const commands = [...detectProject(project.path).commands].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const timeoutS = Math.min(loadConfig().harness.checkTimeoutS, 600);
  const results: BaselineResult[] = [];
  for (const command of commands) {
    const run = await runShell(command.cmd, { cwd: project.path, timeoutS, env: minimalEnv() });
    const passed = run.exitCode === 0 && !run.timedOut;
    const result: BaselineResult = { kind: command.kind, cmd: command.cmd, passed, exitCode: run.exitCode, durationMs: run.durationMs, output: tail(run.output, 20, 2000), missingTool: !passed && !run.timedOut && isMissingTool(run.exitCode, run.output) };
    results.push(result);
    onResult(result);
    bus.emitEvent({ type: "check_result", projectId, title: `${result.passed ? "✓" : result.missingTool ? "–" : "✗"} Baseline ${command.kind}: ${command.cmd}`, detail: result.passed ? `passed in ${(run.durationMs / 1000).toFixed(1)}s` : result.missingTool ? "Skipped: the tool isn't installed on this computer" : tail(run.output, 8), payload: { baseline: true, passed: result.passed } });
  }
  const baseline = { at: new Date().toISOString(), results };
  putSetting(`baseline:${projectId}`, baseline);
  return baseline;
}

/** Extra checks for every phase: the baseline commands that were green, minus anything the phase already runs. */
export function autoChecks(projectId: number, existing: Check[]): Check[] {
  if (!loadConfig().harness.autoVerify) return [];
  const have = new Set(existing.filter(check => check.kind === "cmd").map(check => (check as { cmd: string }).cmd.trim()));
  return (baselineOf(projectId)?.results ?? []).filter(result => result.passed && !have.has(result.cmd)).map(result => ({ kind: "cmd", cmd: result.cmd, timeoutS: Math.max(60, Math.ceil((result.durationMs / 1000) * 3)) }));
}
