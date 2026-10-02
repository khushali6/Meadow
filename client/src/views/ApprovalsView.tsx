import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, ErrorNote, PageHeader, StatusTag, relativeTime } from "../components/common";
import { trpc } from "../lib/trpc";
import type { Approval, ProjectSummary } from "../lib/types";
import { MotionButton } from "../components/animation/motion";

function Countdown({ until }: { until: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000));
  return <span className="countdown">auto-deny in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>;
}

export function ApprovalsView({ approvals, projects }: { approvals: Approval[]; projects: ProjectSummary[] }) {
  const utils = trpc.useUtils();
  const decide = trpc.decideApproval.useMutation({ onSettled: () => { utils.overview.invalidate(); utils.project.invalidate(); } });
  const pending = approvals.filter(item => item.status === "pending");
  const decided = approvals.filter(item => item.status !== "pending").slice(0, 30);
  const projectName = (id: number | null) => projects.find(project => project.id === id)?.name ?? "Meadow";
  const audit = trpc.audit.useQuery({ projectId: null, limit: 100 }, { refetchInterval: 10_000 });
  return (
    <>
      <PageHeader eyebrow="04 / POLICY GATES" title="Every risky action has a boundary." description="Mass deletions and similar actions pause the run until you decide. Anything you don't answer in time is denied, never approved." />
      <ErrorNote error={decide.error} />
      {pending.length === 0 ? <EmptyState icon={ShieldCheck} title="Nothing waiting" body="When a phase tries something risky, it shows up here and in Telegram." /> : null}
      <div className="approval-list">
        {pending.map(item => (
          <div className="approval-card pending" key={item.id}>
            <div className="approval-icon"><ShieldCheck size={18} /></div>
            <div className="approval-main">
              <div className="approval-title-row"><div><strong>{item.title}</strong><span>{projectName(item.project_id)} · {item.kind} · {relativeTime(item.requested_at)}</span></div><span className={`risk-tag ${item.risk}`}>{item.risk} risk</span></div>
              <pre className="approval-detail">{item.detail}</pre>
              <div className="approval-foot">
                <Countdown until={item.expires_at} />
                <div className="approval-actions">
                  <MotionButton className="button secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, decision: "denied" })}><X size={14} /> Deny</MotionButton>
                  <MotionButton className="button primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, decision: "approved" })}><Check size={14} /> Approve</MotionButton>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {decided.length ? (
        <section className="panel history-panel">
          <div className="panel-heading"><div><span className="panel-kicker">History</span><h2>Recent decisions</h2></div></div>
          {decided.map(item => (
            <div className="history-row" key={item.id}>
              <div><strong>{item.title}</strong> <span>{projectName(item.project_id)} · {relativeTime(item.decided_at ?? item.requested_at)}{item.decided_by ? ` · by ${item.decided_by}` : ""}</span></div>
              <StatusTag status={item.status === "approved" ? "passed" : item.status === "expired" ? "stopped" : "blocked"} />
            </div>
          ))}
        </section>
      ) : null}
      <section className="panel history-panel">
        <div className="panel-heading"><div><span className="panel-kicker">Audit log</span><h2>Every tool call, by argument fingerprint</h2></div></div>
        {audit.data ? (
          <div className="audit-policy">
            {Object.entries(audit.data.policy).map(([risk, policy]) => <span key={risk}><span className={`atlas-risk ${risk}`}>{risk}</span> {policy.approval === "none" ? "runs without approval" : `needs ${policy.approval}-risk approval`}{policy.allowFromMcp ? "" : ", never over MCP"}</span>)}
          </div>
        ) : null}
        {audit.data?.rows.length ? (
          <div className="audit-wrap">
            <table className="audit-table">
              <thead><tr><th>When</th><th>Project</th><th>Agent</th><th>Tool</th><th>Risk</th><th>Args hash</th><th>Approval</th><th>Result</th><th>ms</th></tr></thead>
              <tbody>
                {audit.data.rows.map(row => (
                  <tr key={row.id} title={row.detail}>
                    <td>{relativeTime(row.ts)}</td><td>{projectName(row.project_id)}</td><td>{row.agent}</td><td>{row.tool}</td>
                    <td><span className={`atlas-risk ${row.risk}`}>{row.risk}</span></td><td>{row.args_hash}</td><td>{row.approval}</td><td className={`result-${row.result}`}>{row.result}</td><td>{row.duration_ms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="event-empty">No tool calls recorded yet. Arguments are never stored, only a fingerprint.</div>}
      </section>
    </>
  );
}
