import { getDb } from "./core/db";

const DAY_MS = 86_400_000;

/**
 * Operational metrics computed from Meadow's own records (runs, phases, checks, approvals, audit
 * log, investigations). Nothing is estimated: a metric with no data is reported as null.
 */
export function metrics(projectId: number | null, days = 14) {
  const db = getDb();
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const scope = projectId === null ? "" : " AND e.project_id = ?";
  const args = projectId === null ? [since] : [since, projectId];

  const runs = db.all<{ engine: string; status: string; exit_reason: string | null; started_at: string; finished_at: string | null; tokens: number; cost: number }>(
    `SELECT r.engine, r.status, r.exit_reason, r.started_at, r.finished_at, r.tokens_in + r.tokens_out AS tokens, r.cost_usd AS cost FROM runs r JOIN executions e ON e.id = r.execution_id WHERE r.started_at >= ?${scope}`, ...args,
  );
  const durations = runs.filter(run => run.finished_at).map(run => new Date(run.finished_at!).getTime() - new Date(run.started_at).getTime()).filter(ms => ms >= 0).sort((a, b) => a - b);
  const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  const daily = new Map<string, { tokens: number; runs: number; failed: number }>();
  for (let i = days - 1; i >= 0; i--) daily.set(new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10), { tokens: 0, runs: 0, failed: 0 });
  for (const run of runs) {
    const day = daily.get(run.started_at.slice(0, 10));
    if (!day) continue;
    day.tokens += run.tokens;
    day.runs += 1;
    if (run.status === "failed") day.failed += 1;
  }
  const engines = new Map<string, { runs: number; completed: number; tokens: number }>();
  for (const run of runs) {
    const entry = engines.get(run.engine) ?? { runs: 0, completed: 0, tokens: 0 };
    entry.runs += 1;
    entry.tokens += run.tokens;
    if (run.status === "completed") entry.completed += 1;
    engines.set(run.engine, entry);
  }
  const reasons = new Map<string, number>();
  for (const run of runs.filter(run => run.status !== "completed")) reasons.set(run.exit_reason ?? "unknown", (reasons.get(run.exit_reason ?? "unknown") ?? 0) + 1);

  const projectFilter = projectId === null ? "" : " AND pl.project_id = ?";
  const pArgs = projectId === null ? [since] : [since, projectId];
  const phases = db.all<{ status: string; attempts: number }>(`SELECT ph.status, ph.attempts FROM phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE COALESCE(ph.started_at, pl.created_at) >= ?${projectFilter}`, ...pArgs);
  const finished = phases.filter(phase => phase.status === "passed" || phase.status === "blocked");
  const passed = phases.filter(phase => phase.status === "passed");
  const checks = db.all<{ label: string; passed: number; duration_ms: number }>(`SELECT c.label, c.passed, c.duration_ms FROM checks c JOIN phases ph ON ph.id = c.phase_id JOIN plans pl ON pl.id = ph.plan_id WHERE c.ts >= ?${projectFilter}`, ...pArgs);
  const slowest = new Map<string, { runs: number; totalMs: number; failed: number }>();
  for (const check of checks) {
    const entry = slowest.get(check.label) ?? { runs: 0, totalMs: 0, failed: 0 };
    entry.runs += 1;
    entry.totalMs += check.duration_ms;
    if (!check.passed) entry.failed += 1;
    slowest.set(check.label, entry);
  }

  const aScope = projectId === null ? "" : " AND project_id = ?";
  const approvals = db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM approvals WHERE requested_at >= ?${aScope} GROUP BY status`, ...args);
  const tools = db.all<{ risk: string; result: string; n: number; ms: number }>(`SELECT risk, result, COUNT(*) n, AVG(duration_ms) ms FROM audit_log WHERE ts >= ?${aScope} GROUP BY risk, result`, ...args);
  const investigations = db.all<{ created_at: string; finished_at: string | null; status: string }>(`SELECT created_at, finished_at, status FROM atlas_investigations WHERE created_at >= ?${aScope}`, ...args);
  const invMs = investigations.filter(row => row.finished_at).map(row => new Date(row.finished_at!).getTime() - new Date(row.created_at).getTime()).filter(ms => ms >= 0).sort((a, b) => a - b);
  const rateLimited = db.get<{ n: number }>(`SELECT COUNT(*) n FROM events WHERE type = 'guard' AND ts >= ? AND payload_json LIKE '%"rateLimited":true%'${aScope}`, ...args)?.n ?? 0;

  return {
    days,
    runs: {
      total: runs.length,
      completed: runs.filter(run => run.status === "completed").length,
      successRate: runs.length ? runs.filter(run => run.status === "completed").length / runs.length : null,
      p50Ms: pct(durations, 0.5),
      p95Ms: pct(durations, 0.95),
      tokens: runs.reduce((sum, run) => sum + run.tokens, 0),
      costUsd: Number(runs.reduce((sum, run) => sum + run.cost, 0).toFixed(4)),
      failureReasons: Array.from(reasons, ([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      byEngine: Array.from(engines, ([engine, value]) => ({ engine, ...value })),
      rateLimitWaits: rateLimited,
    },
    daily: Array.from(daily, ([day, value]) => ({ day, ...value })),
    phases: {
      total: phases.length,
      passed: passed.length,
      blocked: phases.filter(phase => phase.status === "blocked").length,
      passRate: finished.length ? passed.length / finished.length : null,
      firstTryRate: passed.length ? passed.filter(phase => phase.attempts <= 1).length / passed.length : null,
      avgAttempts: passed.length ? Number((passed.reduce((sum, phase) => sum + phase.attempts, 0) / passed.length).toFixed(2)) : null,
    },
    checks: {
      total: checks.length,
      passRate: checks.length ? checks.filter(check => check.passed).length / checks.length : null,
      slowest: Array.from(slowest, ([label, value]) => ({ label, runs: value.runs, avgMs: Math.round(value.totalMs / value.runs), failed: value.failed })).sort((a, b) => b.avgMs - a.avgMs).slice(0, 8),
    },
    approvals: Object.fromEntries(approvals.map(row => [row.status, row.n])) as Record<string, number>,
    tools: tools.map(row => ({ risk: row.risk, result: row.result, count: row.n, avgMs: Math.round(row.ms ?? 0) })),
    investigations: { total: investigations.length, failed: investigations.filter(row => row.status === "failed").length, p50Ms: pct(invMs, 0.5), p95Ms: pct(invMs, 0.95) },
  };
}

export type Metrics = ReturnType<typeof metrics>;
