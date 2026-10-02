import { loadConfig } from "../config";
import { bus } from "../core/events";
import { minimalEnv, runShell } from "../core/exec";
import { tail } from "../core/redact";
import { getSetting, putSetting } from "../core/settings";
import type { Check } from "../planning/format";
import { getProject } from "../projects";
import { detectProject, type VerifyKind } from "./detect";

export type BaselineResult = { kind: VerifyKind; cmd: string; passed: boolean; exitCode: number | null; durationMs: number; output: string };
export type Baseline = { at: string; results: BaselineResult[] };

const ORDER: VerifyKind[] = ["typecheck", "lint", "test", "build"];

export const baselineOf = (projectId: number) => getSetting<Baseline>(`baseline:${projectId}`);

/**
 * Runs the project's detected verification commands once, on the current tree. Only commands that pass here
 * are enforced after phases, so pre-existing failures (say, old lint errors) never block the agent.
 */
export async function runBaseline(projectId: number, onResult: (result: BaselineResult) => void = () => undefined): Promise<Baseline> {
  const project = getProject(projectId);
  const commands = ORDER.map(kind => detectProject(project.path).commands.find(command => command.kind === kind)).filter((command): command is NonNullable<typeof command> => Boolean(command));
  const timeoutS = Math.min(loadConfig().harness.checkTimeoutS, 600);
  const results: BaselineResult[] = [];
  for (const command of commands) {
    const run = await runShell(command.cmd, { cwd: project.path, timeoutS, env: minimalEnv() });
    const result = { kind: command.kind, cmd: command.cmd, passed: run.exitCode === 0 && !run.timedOut, exitCode: run.exitCode, durationMs: run.durationMs, output: tail(run.output, 20, 2000) };
    results.push(result);
    onResult(result);
    bus.emitEvent({ type: "check_result", projectId, title: `${result.passed ? "✓" : "✗"} Baseline ${command.kind}: ${command.cmd}`, detail: result.passed ? `passed in ${(run.durationMs / 1000).toFixed(1)}s` : tail(run.output, 8), payload: { baseline: true, passed: result.passed } });
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
