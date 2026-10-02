import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Bot, Camera, Check, CheckCircle2, CircleDot, Command, FileCode2, FileText, GitBranch, Pause, Play, RotateCcw, ShieldCheck, SkipForward, Square, Terminal, WandSparkles, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState, ErrorNote, PageHeader, StatusTag, clockTime, relativeTime } from "../components/common";
import { screenshotUrl } from "../lib/api";
import { trpc } from "../lib/trpc";
import type { Event, Phase, ProjectDetail } from "../lib/types";

const eventIcons: Record<string, LucideIcon> = {
  phase_started: Play, thinking: WandSparkles, tool_call: Terminal, file_edit: FileCode2, command_run: Command, check_result: CheckCircle2,
  screenshot: Camera, phase_passed: Check, message: Bot, done: CheckCircle2, error: XCircle, phase_blocked: AlertTriangle, guard: ShieldCheck,
  approval_requested: ShieldCheck, approval_decided: ShieldCheck, session_started: Play, execution_started: Play, execution_finished: CheckCircle2, control: CircleDot, plan_ready: FileText,
};

const FILTERS: Record<string, (event: Event) => boolean> = {
  "All events": () => true,
  Checks: event => ["check_result", "phase_passed", "phase_blocked"].includes(event.type),
  Files: event => ["file_edit", "command_run", "tool_call", "guard"].includes(event.type),
  Problems: event => ["error", "phase_blocked", "guard"].includes(event.type),
};

export function RunView({ detail, onNavigate }: { detail: ProjectDetail; onNavigate: (path: string) => void }) {
  const { project, execution, phases, events } = detail;
  const utils = trpc.useUtils();
  const control = trpc.control.useMutation({ onSettled: () => utils.project.invalidate() });
  const [filter, setFilter] = useState("All events");
  const [selectedPhaseId, setSelectedPhaseId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [hint, setHint] = useState("");
  const [confirmRollback, setConfirmRollback] = useState(false);

  const current = phases.find(phase => !["passed", "skipped"].includes(phase.status));
  const selectedPhase = phases.find(phase => phase.id === selectedPhaseId) ?? current ?? phases[phases.length - 1];
  const filtered = useMemo(() => events.filter(FILTERS[filter]), [events, filter]);
  const passedCount = phases.filter(phase => phase.status === "passed").length;
  const progress = phases.length ? Math.round((passedCount / phases.length) * 100) : 0;
  const active = Boolean(execution?.active);
  const status = active ? "running" : execution?.status ?? (detail.approvedPlanId ? "ready" : "draft");
  const act = (action: "start" | "pause" | "resume" | "stop" | "retry" | "skip" | "rollback", withHint?: string) => control.mutate({ projectId: project.id, action, hint: withHint || undefined });

  if (!detail.approvedPlanId) {
    return (
      <>
        <PageHeader eyebrow={`01 / LIVE CONSOLE · ${project.name}`} title="No approved plan yet." description="Describe what you want on the Request page (or in Telegram), or write a PLAN.md in the Plan editor. Nothing runs until you approve a plan." />
        <EmptyState icon={FileText} title={detail.latestPlan ? `Plan v${detail.latestPlan.version} is waiting for approval` : "Start with a request"} body={detail.latestPlan ? "Review it in the Plan editor and approve it to start." : "Meadow will ask a few questions, write SPEC.md and PLAN.md, then wait for you."} action={<button className="button primary" onClick={() => onNavigate(detail.latestPlan ? "/plans" : "/request")}>{detail.latestPlan ? "Review plan" : "New request"}</button>} />
      </>
    );
  }

  const tokens = execution?.tokens ?? 0;
  const parked = !active && execution && ["blocked", "paused", "waiting", "interrupted"].includes(execution.status);

  return (
    <>
      <PageHeader
        eyebrow={`01 / LIVE CONSOLE · ${project.name} · ${project.engine}`}
        title="Built phase by phase, with receipts."
        description="Every phase is measured by real checks, every change is on its own branch, and nothing runs outside this project folder."
        action={
          <div className="header-actions">
            <button className="button secondary" onClick={() => setConfirmRollback(true)} disabled={control.isPending}><RotateCcw size={15} /> Roll back</button>
            {active ? (
              <>
                <button className="button secondary" onClick={() => act("stop")} disabled={control.isPending}><Square size={14} /> Stop</button>
                <button className="button primary" onClick={() => act("pause")} disabled={control.isPending}><Pause size={15} /> Pause</button>
              </>
            ) : (
              <button className="button primary" onClick={() => act("start")} disabled={control.isPending || passedCount === phases.length}><Play size={15} /> {execution && ["paused", "waiting", "blocked", "interrupted"].includes(execution.status) ? "Resume" : passedCount === phases.length ? "All phases passed" : "Start run"}</button>
            )}
          </div>
        }
      />
      <ErrorNote error={control.error} />
      {confirmRollback ? (
        <div className="banner warn" role="alertdialog">
          <AlertTriangle size={16} />
          <div><strong>Roll back to the last passing phase?</strong><span>The current phase branch is kept under failed/ for inspection; the working tree resets to the main branch.</span></div>
          <div className="banner-actions">
            <button className="button secondary" onClick={() => setConfirmRollback(false)}>Cancel</button>
            <button className="button danger" onClick={() => { act("rollback"); setConfirmRollback(false); }}>Roll back</button>
          </div>
        </div>
      ) : null}
      {parked ? (
        <div className={`banner ${execution!.status === "blocked" ? "error" : "warn"}`}>
          {execution!.status === "blocked" ? <XCircle size={16} /> : <Pause size={16} />}
          <div>
            <strong>{execution!.status === "blocked" ? "This phase is stuck" : execution!.status === "interrupted" ? "Run was interrupted" : execution!.status === "waiting" ? "Phase passed — waiting for you" : "Run paused"}</strong>
            <span>{execution!.note ?? "Resume to continue from the last verified state."}</span>
            {execution!.status === "blocked" ? <input className="hint-input" placeholder="Optional hint for the agent, e.g. 'use the existing cart store'" value={hint} onChange={event => setHint(event.target.value)} /> : null}
          </div>
          <div className="banner-actions">
            {execution!.status === "blocked" ? (
              <>
                <button className="button secondary" onClick={() => act("skip")}><SkipForward size={14} /> Skip phase</button>
                <button className="button primary" onClick={() => { act("retry", hint); setHint(""); }}><RotateCcw size={14} /> Retry{hint ? " with hint" : ""}</button>
              </>
            ) : (
              <button className="button primary" onClick={() => act("resume")}><Play size={14} /> {execution!.status === "waiting" ? "Continue" : "Resume"}</button>
            )}
          </div>
        </div>
      ) : null}
      <div className="run-meta-row">
        <div className="run-meta">
          <span className="live-status">{active ? <span className="pulse-dot" /> : null}<StatusTag status={status} /> {current ? `phase ${phases.indexOf(current) + 1} of ${phases.length}` : `${phases.length} of ${phases.length}`}</span>
          {current?.branch ? <><span className="meta-divider" /><span className="branch-label"><GitBranch size={14} /> {current.branch}</span></> : null}
          {execution ? <><span className="meta-divider" /><span className="meta-muted">Started {relativeTime(execution.started_at)}</span></> : null}
        </div>
        <div className="budget">
          <span>Tokens this run</span>
          <strong>{tokens.toLocaleString()} / {detail.budget.phaseTokens.toLocaleString()} per phase</strong>
          <div className="budget-track"><span style={{ width: `${Math.min(100, (tokens / detail.budget.phaseTokens) * 100)}%` }} /></div>
        </div>
      </div>
      <div className="run-grid">
        <section className="panel phases-panel" aria-label="Phases">
          <div className="panel-heading"><div><span className="panel-kicker">Execution plan</span><h2>Phases</h2></div><span className="progress-label">{passedCount}/{phases.length} passed</span></div>
          <div className="phase-list">
            {phases.map((phase, index) => {
              const done = phase.status === "passed";
              const isCurrent = phase.id === current?.id;
              return (
                <button className={`phase-item ${phase.id === selectedPhase?.id ? "current" : ""}`} key={phase.id} onClick={() => setSelectedPhaseId(phase.id)} aria-current={isCurrent ? "step" : undefined}>
                  <div className="phase-rail">
                    <div className={`phase-node ${done ? "done" : isCurrent ? "active" : ""}`}>{done ? <Check size={13} /> : index + 1}</div>
                    {index < phases.length - 1 ? <div className={`phase-line ${done ? "filled" : ""}`} /> : null}
                  </div>
                  <div className="phase-content">
                    <div className="phase-title-row"><strong>{phase.name}</strong><StatusTag status={isCurrent && active ? phase.status : phase.status} /></div>
                    <p>{phase.summary ?? phase.doneWhen}</p>
                    <div className="phase-foot"><span><GitBranch size={12} /> {phase.branch?.replace("meadow/", "") ?? "no branch yet"}</span><span>{phase.attempts} {phase.attempts === 1 ? "attempt" : "attempts"}</span></div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="phase-summary"><div className="summary-ring"><span>{progress}%</span></div><div><strong>{passedCount === phases.length ? "Every phase has its receipts" : active ? "Work is in motion" : "Ready when you are"}</strong><span>{passedCount} of {phases.length} phases passed their checks.</span></div></div>
        </section>

        <section className="panel events-panel" aria-label="Live event stream">
          <div className="panel-heading event-heading"><div><span className="panel-kicker">Live event stream</span><h2>What Meadow is doing</h2></div><div className="event-count">{active ? <span className="pulse-dot" /> : null} {filtered.length} events</div></div>
          <div className="filter-row"><div className="filter-tabs" role="tablist">{Object.keys(FILTERS).map(name => <button key={name} role="tab" aria-selected={filter === name} className={filter === name ? "selected" : ""} onClick={() => setFilter(name)}>{name}</button>)}</div></div>
          <div className="event-list" aria-live="polite">
            {filtered.length === 0 ? <div className="event-empty">No events yet. Start the run to see the engine work.</div> : null}
            {filtered.slice().reverse().map(event => {
              const Icon = eventIcons[event.type] ?? CircleDot;
              const open = expanded === event.id;
              return (
                <button className={`event-row ${open ? "selected" : ""}`} key={event.id} onClick={() => { setExpanded(open ? null : event.id); if (event.phaseId) setSelectedPhaseId(event.phaseId); }}>
                  <div className={`event-icon event-${event.type}`}><Icon size={14} /></div>
                  <div className="event-copy">
                    <div className="event-title"><strong>{event.title}</strong><time>{clockTime(event.ts)}</time></div>
                    {event.detail ? (open ? <pre className="event-detail">{event.detail}</pre> : <p>{event.detail.split("\n")[0].slice(0, 220)}</p>) : null}
                    <div className="event-meta"><span className="evidence-chip">{event.type.replace(/_/g, " ")}</span>{event.phaseId ? <span>Phase {phases.findIndex(phase => phase.id === event.phaseId) + 1 || "–"}</span> : null}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {selectedPhase ? <Inspector phase={selectedPhase} index={phases.indexOf(selectedPhase)} /> : null}
      </div>
    </>
  );
}

function Inspector({ phase, index }: { phase: Phase; index: number }) {
  const [tab, setTab] = useState("Checks");
  const evidence = trpc.phaseEvidence.useQuery({ phaseId: phase.id }, { refetchInterval: 4000 });
  const diff = trpc.phaseDiff.useQuery({ phaseId: phase.id }, { enabled: tab === "Diff", refetchInterval: tab === "Diff" ? 8000 : false });
  const [runIndex, setRunIndex] = useState(0);
  const runs = evidence.data?.runs ?? [];
  const additions = diff.data?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions = diff.data?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  return (
    <section className="panel inspector-panel" aria-label="Evidence">
      <div className="panel-heading"><div><span className="panel-kicker">Phase {index + 1} evidence</span><h2>{phase.name}</h2></div></div>
      <div className="inspector-tabs" role="tablist">{["Checks", "Diff", "Screenshots", "Prompt"].map(name => <button className={tab === name ? "selected" : ""} role="tab" aria-selected={tab === name} key={name} onClick={() => setTab(name)}>{name}</button>)}</div>
      {tab === "Checks" ? (
        <div className="inspector-body check-stack">
          <div className="check-plan">
            <span className="panel-kicker">Acceptance checks</span>
            {phase.checks.map(check => <code key={check}>{check}</code>)}
          </div>
          {(evidence.data?.checks ?? []).length === 0 ? <div className="event-empty">No check results yet.</div> : null}
          {(evidence.data?.checks ?? []).map(check => (
            <details className="check-row-details" key={check.id}>
              <summary className="check-row">
                <div className={`check-state ${check.passed ? "" : "failed"}`}>{check.passed ? <Check size={12} /> : <XCircle size={12} />}</div>
                <div><strong>{check.label}</strong><code>exit {check.exit_code ?? "—"} · {(check.duration_ms / 1000).toFixed(1)}s · {relativeTime(check.ts)}</code></div>
                <span className={`check-status ${check.passed ? "" : "failed"}`}>{check.passed ? "passed" : "failed"}</span>
              </summary>
              <pre className="output-tail">{check.output_tail || "(no output)"}</pre>
            </details>
          ))}
        </div>
      ) : null}
      {tab === "Diff" ? (
        <div className="inspector-body">
          <div className="inspector-stat-row"><div><span>Changed files</span><strong>{diff.data?.files.length ?? "…"}</strong></div><div><span>Lines</span><strong className="positive">+{additions} −{deletions}</strong></div></div>
          <div className="diff-list">{(diff.data?.files ?? []).map(file => <div className="diff-file" key={file.path}><div className={`file-kind ${file.kind}`}>{file.kind[0].toUpperCase()}</div><span>{file.path}</span><div className="diff-numbers"><b>+{file.additions}</b><em>−{file.deletions}</em></div></div>)}</div>
          {diff.data?.text ? <pre className="diff-text">{diff.data.text.split("\n").map((line, i) => <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : undefined}>{line}{"\n"}</span>)}</pre> : <div className="event-empty">{diff.isLoading ? "Loading diff…" : "No changes on this phase yet."}</div>}
        </div>
      ) : null}
      {tab === "Screenshots" ? (
        <div className="inspector-body shot-grid">
          {(evidence.data?.screenshots ?? []).length === 0 ? <div className="event-empty">No screenshots for this phase. Web projects with a preview block get desktop and mobile captures after checks pass.</div> : null}
          {(evidence.data?.screenshots ?? []).map(shot => (
            <a className="shot-card" key={shot.id} href={screenshotUrl(shot.id)} target="_blank" rel="noreferrer">
              <img src={screenshotUrl(shot.id)} alt={`Screenshot of ${shot.label}`} loading="lazy" />
              <div className="shot-caption"><div><strong>{shot.label}</strong><span>{shot.viewport} · {relativeTime(shot.ts)}</span></div></div>
            </a>
          ))}
        </div>
      ) : null}
      {tab === "Prompt" ? (
        <div className="inspector-body prompt-body">
          {runs.length === 0 ? <div className="event-empty">No engine runs yet for this phase.</div> : (
            <>
              <div className="prompt-label">
                <select value={runIndex} onChange={event => setRunIndex(Number(event.target.value))} aria-label="Engine run">
                  {runs.map((run, i) => <option key={run.id} value={i}>Run {run.id} · {run.kind} · {run.status}{run.exit_reason ? ` (${run.exit_reason})` : ""}</option>)}
                </select>
                <span className="evidence-chip">{runs[runIndex]?.engine}</span>
              </div>
              <pre>{runs[runIndex]?.prompt}</pre>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
