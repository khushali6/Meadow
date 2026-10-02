import { AlertTriangle, CheckCircle2, FileText, History, Play, Save, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorNote, PageHeader, StatusTag, relativeTime } from "../components/common";
import { lineDiff } from "../lib/diff";
import { trpc } from "../lib/trpc";
import type { ProjectDetail } from "../lib/types";
import { MotionButton, TabIndicator } from "../components/animation/motion";

const TEMPLATE = (project: string) => `---
project: ${project}
goal: One sentence describing the outcome
stack: web
preview:
  command: npm run dev -- --port 5173
  url: http://127.0.0.1:5173
  routes: ["/"]
phases:
  - id: setup
    name: Project scaffold
    tasks:
      - Create the app skeleton with a test runner
    checks:
      - file_exists: package.json
      - cmd: npm test
    done_when: The app builds and the test suite runs
---

# Notes

Anything here is passed to the engine as context.
`;

export function PlanView({ detail, onNavigate }: { detail: ProjectDetail; onNavigate: (path: string) => void }) {
  const { project, latestPlan } = detail;
  const utils = trpc.useUtils();
  const [markdown, setMarkdown] = useState(latestPlan?.raw ?? TEMPLATE(project.name));
  const [loadedId, setLoadedId] = useState(latestPlan?.id ?? null);
  const [tab, setTab] = useState<"plan" | "spec" | "history">("plan");
  const [compareId, setCompareId] = useState<number | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const validate = trpc.validatePlan.useMutation();
  const save = trpc.savePlan.useMutation({ onSuccess: plan => { setLoadedId(plan.id); utils.project.invalidate(); utils.planHistory.invalidate(); } });
  const approve = trpc.approvePlan.useMutation({ onSuccess: () => { utils.project.invalidate(); utils.overview.invalidate(); onNavigate("/"); } });
  const improve = trpc.improvePlan.useMutation({ onSuccess: plan => { setMarkdown(plan.raw_md); setLoadedId(plan.id); utils.project.invalidate(); utils.planHistory.invalidate(); } });
  const history = trpc.planHistory.useQuery({ projectId: project.id });

  useEffect(() => {
    if (latestPlan && latestPlan.id !== loadedId && markdown === (history.data?.find(item => item.id === loadedId)?.raw ?? markdown)) {
      setMarkdown(latestPlan.raw);
      setLoadedId(latestPlan.id);
    }
  }, [latestPlan?.id]);

  useEffect(() => {
    const timer = setTimeout(() => validate.mutate({ markdown }), 350);
    return () => clearTimeout(timer);
  }, [markdown]);

  const result = validate.data;
  const loaded = history.data?.find(item => item.id === loadedId);
  const dirty = !loaded || loaded.raw !== markdown;
  const isApproved = loaded?.status === "approved" && !dirty;
  const comparing = history.data?.find(item => item.id === compareId);
  const diff = useMemo(() => (comparing ? lineDiff(comparing.raw, markdown) : []), [comparing, markdown]);

  const jumpToLine = (line: number | null | undefined) => {
    if (!line || !textRef.current) return;
    const lines = markdown.split("\n");
    const offset = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
    textRef.current.focus();
    textRef.current.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0));
    textRef.current.scrollTop = Math.max(0, (line - 5) * 20);
  };

  const saveAndApprove = async () => {
    let planId = loadedId;
    if (dirty) planId = (await save.mutateAsync({ projectId: project.id, markdown })).id;
    if (planId) approve.mutate({ planId, start: true });
  };

  return (
    <>
      <PageHeader
        eyebrow={`03 / EXECUTION PLAN · ${project.name}`}
        title="Make the work legible."
        description="Every phase needs at least one check that can actually fail. Meadow refuses to start until the plan validates, and every save is a new version you can compare or restore."
        action={
          <div className="header-actions">
            <MotionButton className="button secondary" disabled={!loadedId || improve.isPending} onClick={() => loadedId && improve.mutate({ planId: loadedId })}><WandSparkles size={15} /> {improve.isPending ? "Improving…" : "Suggest better checks"}</MotionButton>
            <MotionButton className="button secondary" disabled={!result?.ok || !dirty || save.isPending} onClick={() => save.mutate({ projectId: project.id, markdown })}><Save size={15} /> Save version</MotionButton>
            <MotionButton className="button primary" disabled={!result?.ok || approve.isPending || save.isPending || (isApproved && detail.execution?.active)} onClick={saveAndApprove}><Play size={15} /> {isApproved ? "Start run" : "Approve and start"}</MotionButton>
          </div>
        }
      />
      <ErrorNote error={save.error ?? approve.error ?? improve.error} />
      <div className="plan-layout">
        <section className="panel editor-panel">
          <div className="inspector-tabs" role="tablist">
            <button className={tab === "plan" ? "selected" : ""} onClick={() => setTab("plan")}>PLAN.md{tab === "plan" ? <TabIndicator id="plan-tab" /> : null}</button>
            <button className={tab === "spec" ? "selected" : ""} onClick={() => setTab("spec")} disabled={!latestPlan?.spec}>SPEC.md{tab === "spec" ? <TabIndicator id="plan-tab" /> : null}</button>
            <button className={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}><History size={13} /> Versions{tab === "history" ? <TabIndicator id="plan-tab" /> : null}</button>
          </div>
          {tab === "plan" ? (
            <div className="editor-wrap">
              <div className="editor-meta">
                <span><FileText size={14} /> {loaded ? `v${loaded.version} · ${loaded.source}` : "unsaved"}{dirty ? " · edited" : ""}</span>
                {loaded ? <StatusTag status={loaded.status === "approved" ? "passed" : loaded.status === "superseded" ? "skipped" : "draft"} /> : null}
              </div>
              <textarea ref={textRef} className="plan-editor" spellCheck={false} value={markdown} onChange={event => setMarkdown(event.target.value)} aria-label="PLAN.md" />
            </div>
          ) : null}
          {tab === "spec" ? <pre className="spec-view">{latestPlan?.spec ?? "No SPEC.md for this plan."}</pre> : null}
          {tab === "history" ? (
            <div className="history-wrap">
              <div className="history-list">
                {(history.data ?? []).map(item => (
                  <div key={item.id} className={`history-row ${compareId === item.id ? "selected" : ""}`}>
                    <div><strong>v{item.version}</strong> <span>{item.source} · {relativeTime(item.created_at)}</span></div>
                    <StatusTag status={item.status === "approved" ? "passed" : item.status === "superseded" ? "skipped" : "draft"} />
                    <div className="history-actions">
                      <MotionButton className="button ghost small" onClick={() => setCompareId(compareId === item.id ? null : item.id)}>{compareId === item.id ? "Hide diff" : "Compare"}</MotionButton>
                      <MotionButton className="button ghost small" onClick={() => { setMarkdown(item.raw); setLoadedId(item.id); setTab("plan"); }}>Restore</MotionButton>
                    </div>
                  </div>
                ))}
                {history.data?.length === 0 ? <div className="event-empty">No saved versions yet.</div> : null}
              </div>
              {comparing ? (
                <pre className="diff-text">
                  <span className="hunk">v{comparing.version} → editor{"\n"}</span>
                  {diff.map((line, i) => <span key={i} className={line.kind === "add" ? "add" : line.kind === "del" ? "del" : undefined}>{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}{"\n"}</span>)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </section>
        <aside className="panel validation-panel">
          <div className="panel-heading"><div><span className="panel-kicker">Validation</span><h2>{!result ? "Checking…" : result.ok ? "Plan is valid" : `${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}`}</h2></div>{result?.ok ? <CheckCircle2 size={18} className="positive" /> : result ? <AlertTriangle size={18} className="negative" /> : null}</div>
          <div className="validation-list">
            {result?.errors.map((error, i) => (
              <button key={i} className="validation-item error" onClick={() => jumpToLine(error.line)}>
                <span>{error.line ? `Line ${error.line}` : "Plan"} · {error.field}</span>
                <p>{error.message}</p>
              </button>
            ))}
            {result?.warnings.map((warning, i) => (
              <button key={`w${i}`} className="validation-item warn" onClick={() => jumpToLine(warning.line)}>
                <span>{warning.line ? `Line ${warning.line}` : "Plan"} · {warning.field}</span>
                <p>{warning.message}</p>
              </button>
            ))}
          </div>
          {result?.ok ? (
            <div className="phase-graph">
              <span className="panel-kicker">Phase graph</span>
              {result.phases.map((phase, i) => (
                <div className="graph-node" key={phase.id}>
                  <div className="phase-node">{i + 1}</div>
                  <div><strong>{phase.name}</strong><span>{phase.id} · {phase.checks} check{phase.checks === 1 ? "" : "s"}{phase.dependsOn.length ? ` · after ${phase.dependsOn.join(", ")}` : ""}</span></div>
                </div>
              ))}
            </div>
          ) : null}
          {!latestPlan ? <EmptyState icon={FileText} title="Starting from a template" body="Edit it here, or let Meadow write one from a plain-language request." action={<MotionButton className="button secondary small" onClick={() => onNavigate("/request")}>Use a request instead</MotionButton>} /> : null}
        </aside>
      </div>
    </>
  );
}
