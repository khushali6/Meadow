import { Activity } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorNote, PageHeader } from "../components/common";
import { trpc } from "../lib/trpc";
import type { ProjectSummary } from "../lib/types";

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const duration = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="metric-tile"><span>{label}</span><strong>{value}</strong>{hint ? <em>{hint}</em> : null}</div>;
}

export function MetricsView({ project }: { project: ProjectSummary | undefined }) {
  const [scope, setScope] = useState<"project" | "all">(project ? "project" : "all");
  const [days, setDays] = useState(14);
  const data = trpc.metrics.useQuery({ projectId: scope === "project" && project ? project.id : null, days }, { refetchInterval: 30_000 });
  const m = data.data;
  const maxTokens = Math.max(1, ...(m?.daily.map(day => day.tokens) ?? [1]));

  return (
    <>
      <PageHeader
        eyebrow="09 / OBSERVABILITY"
        title="Measured, not guessed."
        description="Every number here is computed from Meadow's own records on this machine: engine runs, phases, checks, approvals, the tool audit log and CodeAtlas investigations. Empty means no data yet."
        action={
          <div className="header-actions">
            <div className="atlas-modes" role="radiogroup" aria-label="Scope">
              <button type="button" role="radio" aria-checked={scope === "project"} className={scope === "project" ? "active" : ""} disabled={!project} onClick={() => setScope("project")}>{project?.name ?? "Project"}</button>
              <button type="button" role="radio" aria-checked={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>All projects</button>
            </div>
            <select value={days} onChange={event => setDays(Number(event.target.value))} aria-label="Time window"><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select>
          </div>
        }
      />
      <ErrorNote error={data.error} />
      {m && !m.runs.total && !m.investigations.total && !m.tools.length ? <EmptyState icon={Activity} title="No activity in this window" body="Run a plan or ask CodeAtlas a question and the numbers show up here." /> : null}
      {m ? (
        <div className="metrics-grid">
          <section className="panel metrics-section">
            <div className="panel-heading"><div><span className="panel-kicker">Engine runs</span><h2>{m.runs.total} runs · {percent(m.runs.successRate)} completed</h2></div></div>
            <div className="metric-tiles">
              <Stat label="Median run" value={duration(m.runs.p50Ms)} />
              <Stat label="p95 run" value={duration(m.runs.p95Ms)} />
              <Stat label="Tokens" value={m.runs.tokens.toLocaleString()} hint={m.runs.costUsd ? `$${m.runs.costUsd} reported by engines` : "cost as reported by engines"} />
              <Stat label="Rate-limit waits" value={String(m.runs.rateLimitWaits)} hint="did not use attempts" />
            </div>
            <div className="metric-bars" aria-label="Tokens per day">
              {m.daily.map(day => <div key={day.day} className="metric-bar" title={`${day.day}: ${day.tokens.toLocaleString()} tokens, ${day.runs} runs, ${day.failed} failed`}><span style={{ height: `${(day.tokens / maxTokens) * 100}%` }} className={day.failed ? "has-failed" : ""} /><em>{day.day.slice(8)}</em></div>)}
            </div>
            {m.runs.byEngine.length ? <table className="audit-table"><thead><tr><th>Engine</th><th>Runs</th><th>Completed</th><th>Tokens</th></tr></thead><tbody>{m.runs.byEngine.map(row => <tr key={row.engine}><td>{row.engine}</td><td>{row.runs}</td><td>{percent(row.runs ? row.completed / row.runs : null)}</td><td>{row.tokens.toLocaleString()}</td></tr>)}</tbody></table> : null}
            {m.runs.failureReasons.length ? <div className="metric-reasons">{m.runs.failureReasons.map(item => <span key={item.reason} className="capability no">{item.reason} · {item.count}</span>)}</div> : null}
          </section>
          <section className="panel metrics-section">
            <div className="panel-heading"><div><span className="panel-kicker">Phases and checks</span><h2>{m.phases.passed}/{m.phases.total} phases passed</h2></div></div>
            <div className="metric-tiles">
              <Stat label="Pass rate" value={percent(m.phases.passRate)} hint="of finished phases" />
              <Stat label="First try" value={percent(m.phases.firstTryRate)} hint="passed on attempt 1" />
              <Stat label="Avg attempts" value={m.phases.avgAttempts === null ? "—" : String(m.phases.avgAttempts)} />
              <Stat label="Check pass rate" value={percent(m.checks.passRate)} hint={`${m.checks.total} check runs`} />
            </div>
            {m.checks.slowest.length ? <table className="audit-table"><thead><tr><th>Slowest checks</th><th>Runs</th><th>Avg</th><th>Failed</th></tr></thead><tbody>{m.checks.slowest.map(row => <tr key={row.label}><td>{row.label}</td><td>{row.runs}</td><td>{duration(row.avgMs)}</td><td className={row.failed ? "result-error" : ""}>{row.failed}</td></tr>)}</tbody></table> : null}
          </section>
          <section className="panel metrics-section">
            <div className="panel-heading"><div><span className="panel-kicker">Policy and tools</span><h2>{Object.values(m.approvals).reduce((a, b) => a + b, 0)} approvals · {m.tools.reduce((sum, row) => sum + row.count, 0)} tool calls</h2></div></div>
            <div className="metric-tiles">
              {(["approved", "denied", "expired", "pending"] as const).map(status => <Stat key={status} label={status} value={String(m.approvals[status] ?? 0)} />)}
            </div>
            {m.tools.length ? <table className="audit-table"><thead><tr><th>Risk</th><th>Result</th><th>Calls</th><th>Avg</th></tr></thead><tbody>{m.tools.map(row => <tr key={`${row.risk}-${row.result}`}><td><span className={`atlas-risk ${row.risk}`}>{row.risk}</span></td><td className={`result-${row.result}`}>{row.result}</td><td>{row.count}</td><td>{duration(row.avgMs)}</td></tr>)}</tbody></table> : null}
          </section>
          <section className="panel metrics-section">
            <div className="panel-heading"><div><span className="panel-kicker">CodeAtlas</span><h2>{m.investigations.total} investigations</h2></div></div>
            <div className="metric-tiles">
              <Stat label="Median" value={duration(m.investigations.p50Ms)} />
              <Stat label="p95" value={duration(m.investigations.p95Ms)} />
              <Stat label="Failed" value={String(m.investigations.failed)} />
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
