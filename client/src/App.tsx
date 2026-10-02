import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import ErrorBoundary from "./components/ErrorBoundary";
import { useLocation } from "wouter";
import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Bell, BookOpen, Bot, Boxes, Check,
  CheckCircle2, ChevronDown, CircleDot, Clock3, Code2, Command, Copy, FileCode2, FileText,
  FolderGit2, GitBranch, Github, Hammer, History, Inbox, Leaf, Menu, Moon, MoreHorizontal,
  Network, Pause, Play, Plus, RotateCcw, Search, Settings2, ShieldCheck, Square, Sun, Terminal,
  Trash2, UploadCloud, WandSparkles, X, Zap
} from "lucide-react";

const navItems = [
  { key: "run", label: "Run view", icon: Activity, path: "/run" },
  { key: "projects", label: "Projects", icon: Boxes, path: "/projects" },
  { key: "plans", label: "Plan editor", icon: FileText, path: "/plans" },
  { key: "approvals", label: "Approvals", icon: ShieldCheck, path: "/approvals", badge: true },
  { key: "memory", label: "Memory", icon: BookOpen, path: "/memory" },
];

const eventIcons: Record<string, LucideIcon> = {
  phase_started: Play,
  thinking: WandSparkles,
  tool_call: Terminal,
  file_edit: FileCode2,
  command_run: Command,
  check_result: CheckCircle2,
  screenshot: WandSparkles,
  phase_passed: Check,
  message: Bot,
  done: CheckCircle2,
};

const relativeTime = (date: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
};

const clockTime = (date: string) => new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Toaster />
          <MeadowApp />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

function MeadowApp() {
  const [, navigate] = useLocation();
  const [location] = useLocation();
  const [mobileNav, setMobileNav] = useState(false);
  const [activeEvent, setActiveEvent] = useState<number | null>(null);
  const [eventFilter, setEventFilter] = useState("All events");
  const [inspectorTab, setInspectorTab] = useState("Diff");
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [newNote, setNewNote] = useState({ title: "", body: "" });
  const [newProject, setNewProject] = useState({ name: "", engine: "Cursor CLI", description: "" });
  const [plan, setPlan] = useState("---\nproject: meadow-console\ngoal: Make the harness observable and recoverable\n---\n\n# Meadow Console\n\n## Phase 1 — Foundation & shell\n- Establish the command-center layout and design tokens.\n- Check: `pnpm build`\n\n## Phase 2 — Projects & state\n- Persist projects, phases, and settings.\n- Check: `pnpm test -- state`\n\n## Phase 3 — Run harness\n- Stream engine events and verify every phase.\n- Check: `pnpm test -- harness`\n");
  const [search, setSearch] = useState("");
  const { theme, toggleTheme } = useTheme();
  const utils = trpc.useUtils();
  const snapshotQuery = trpc.meadow.snapshot.useQuery(undefined, { refetchInterval: 1500, refetchOnWindowFocus: true });
  const doctorQuery = trpc.meadow.doctor.useQuery();
  const createProjectMutation = trpc.meadow.createProject.useMutation({ onSuccess: () => { setShowNewProject(false); setNewProject({ name: "", engine: "Cursor CLI", description: "" }); utils.meadow.snapshot.invalidate(); } });
  const startRunMutation = trpc.meadow.startRun.useMutation({ onSuccess: () => utils.meadow.snapshot.invalidate() });
  const controlMutation = trpc.meadow.controlRun.useMutation({ onSuccess: () => utils.meadow.snapshot.invalidate() });
  const approvalMutation = trpc.meadow.decideApproval.useMutation({ onSuccess: () => utils.meadow.snapshot.invalidate() });
  const addNoteMutation = trpc.meadow.addNote.useMutation({ onSuccess: () => { setShowNoteForm(false); setNewNote({ title: "", body: "" }); utils.meadow.snapshot.invalidate(); } });
  const settingsMutation = trpc.meadow.updateSettings.useMutation({ onSuccess: () => utils.meadow.snapshot.invalidate() });
  const validateMutation = trpc.meadow.validatePlan.useMutation();

  const data = snapshotQuery.data;
  const project = data?.projects.find(item => item.id === data.activeProjectId) ?? data?.projects[0];
  const run = data?.runs.find(item => item.id === data.activeRunId) ?? data?.runs[0];
  const activePhase = project?.phases.find(item => item.index === run?.phaseIndex) ?? project?.phases[0];
  const pendingApprovals = data?.approvals.filter(item => item.status === "pending").length ?? 0;
  const view = location === "/" ? "run" : location.slice(1) || "run";

  useEffect(() => {
    if (location === "/") navigate("/run", { replace: true });
  }, [location, navigate]);

  const filteredEvents = useMemo(() => {
    if (!data) return [];
    const events = data.events.filter(event => !run || event.runId === run.id);
    if (eventFilter === "Checks") return events.filter(event => event.type === "check_result" || event.type === "command_run" || event.type === "phase_passed");
    if (eventFilter === "Files") return events.filter(event => event.type === "file_edit" || event.type === "tool_call");
    return search ? events.filter(event => `${event.title} ${event.detail}`.toLowerCase().includes(search.toLowerCase())) : events;
  }, [data, eventFilter, run, search]);

  if (!data || !project || !run) return <div className="loading-screen"><div className="brand-mark"><Leaf size={20} /></div><span>Loading Meadow workspace…</span></div>;

  const navigateTo = (path: string) => { setMobileNav(false); navigate(path); };
  const runAction = (action: "pause" | "resume" | "stop" | "retry" | "rollback") => controlMutation.mutate({ runId: run.id, action });

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand-lockup" onClick={() => navigateTo("/run")} role="button" tabIndex={0}>
          <div className="brand-mark"><Leaf size={17} strokeWidth={2.4} /></div>
          <div><div className="brand-name">meadow</div><div className="brand-tagline">local-first agent</div></div>
        </div>
        <div className="workspace-switcher">
          <div className="workspace-icon"><FolderGit2 size={16} /></div>
          <div className="workspace-copy"><strong>{project.name}</strong><span>{project.engine}</span></div>
          <ChevronDown size={15} className="muted-icon" />
        </div>
        <div className="nav-label">Workspace</div>
        <nav className="main-nav">
          {navItems.map(item => <button key={item.key} className={`nav-item ${view === item.key ? "active" : ""}`} onClick={() => navigateTo(item.path)}><item.icon size={17} /><span>{item.label}</span>{item.badge && pendingApprovals > 0 ? <b className="nav-badge">{pendingApprovals}</b> : null}</button>)}
        </nav>
        <div className="nav-label nav-label-spaced">System</div>
        <nav className="main-nav">
          <button className={`nav-item ${view === "settings" ? "active" : ""}`} onClick={() => navigateTo("/settings")}><Settings2 size={17} /><span>Settings</span></button>
          <button className="nav-item" onClick={() => navigateTo("/projects")}><Github size={17} /><span>Repository</span><ArrowUpRight size={13} className="nav-external" /></button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="safety-card"><div className="safety-icon"><ShieldCheck size={15} /></div><div><strong>Local boundary active</strong><span>Only this project root is in scope.</span></div></div>
        <div className="sidebar-footer"><div className="avatar">AM</div><div className="user-copy"><strong>Alex Morgan</strong><span>Owner</span></div><button className="icon-button small"><MoreHorizontal size={16} /></button></div>
      </aside>
      {mobileNav ? <button className="mobile-overlay" onClick={() => setMobileNav(false)} aria-label="Close navigation" /> : null}
      <main className="main-canvas">
        <header className="topbar"><button className="mobile-menu icon-button" onClick={() => setMobileNav(true)}><Menu size={19} /></button><div className="breadcrumb"><span>Meadow</span><span className="crumb-separator">/</span><strong>{view === "run" ? "Run view" : view.charAt(0).toUpperCase() + view.slice(1)}</strong></div><div className="topbar-actions"><div className="status-inline"><span className="pulse-dot" /> <span>Daemon connected</span></div><button className="icon-button" onClick={() => toggleTheme?.()} aria-label="Toggle theme">{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button><button className="icon-button notification-button"><Bell size={17} /><span /></button><div className="topbar-avatar">AM</div></div></header>
        <div className="page-wrap">
          {view === "run" && <RunView project={project} run={run} activePhase={activePhase} events={filteredEvents} allEvents={data.events} eventFilter={eventFilter} setEventFilter={setEventFilter} inspectorTab={inspectorTab} setInspectorTab={setInspectorTab} activeEvent={activeEvent} setActiveEvent={setActiveEvent} onRunAction={runAction} onStart={() => startRunMutation.mutate({ projectId: project.id })} running={startRunMutation.isPending || controlMutation.isPending} />}
          {view === "projects" && <ProjectsView projects={data.projects} onNew={() => setShowNewProject(true)} onOpen={(projectId: string) => { const next = data.projects.find(item => item.id === projectId); if (next) navigateTo("/run"); }} />}
          {view === "plans" && <PlanView plan={plan} setPlan={setPlan} onValidate={() => validateMutation.mutate({ markdown: plan })} result={validateMutation.data} />}
          {view === "approvals" && <ApprovalsView approvals={data.approvals} onDecide={(id: string, decision: "approved" | "denied") => approvalMutation.mutate({ id, decision })} />}
          {view === "memory" && <MemoryView notes={data.notes} search={search} setSearch={setSearch} showForm={showNoteForm} setShowForm={setShowNoteForm} newNote={newNote} setNewNote={setNewNote} onAdd={() => addNoteMutation.mutate(newNote)} />}
          {view === "settings" && <SettingsView settings={data.settings} doctor={doctorQuery.data?.engines ?? []} onSave={(values: { notificationLevel?: "all" | "phases" | "failures"; screenshotEnabled?: boolean; previewUrl?: string; budget?: number; quietHours?: boolean; theme?: "light" | "dark" }) => settingsMutation.mutate(values)} saving={settingsMutation.isPending} />}
        </div>
      </main>
      {showNewProject ? <NewProjectDialog value={newProject} setValue={setNewProject} onClose={() => setShowNewProject(false)} onCreate={() => createProjectMutation.mutate(newProject)} saving={createProjectMutation.isPending} /> : null}
    </div>
  );
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function RunView({ project, run, activePhase, events, allEvents, eventFilter, setEventFilter, inspectorTab, setInspectorTab, activeEvent, setActiveEvent, onRunAction, onStart, running }: any) {
  const passedCount = project.phases.filter((phase: any) => phase.status === "passed").length;
  const progress = Math.round((passedCount / project.phases.length) * 100);
  const isRunning = run.status === "running";
  return <>
    <PageHeader eyebrow={`Active run · ${run.id}`} title="Build with receipts." description="Every phase is measured, every change is recoverable, and nothing runs outside your project boundary." action={<div className="header-actions"><button className="button secondary" onClick={() => onRunAction("rollback")}><RotateCcw size={15} /> Roll back</button><button className="button primary" onClick={isRunning ? () => onRunAction("pause") : () => onStart()}>{isRunning ? <><Pause size={15} /> Pause run</> : <><Play size={15} /> {run.status === "stopped" ? "Run again" : "Resume run"}</>}</button></div>} />
    <div className="run-meta-row"><div className="run-meta"><span className="live-status"><span className="pulse-dot" /> {run.status === "running" ? `Running phase ${run.phaseIndex} of ${project.phases.length}` : `${run.status} · phase ${run.phaseIndex}`}</span><span className="meta-divider" /><span className="branch-label"><GitBranch size={14} /> {activePhase?.branch}</span><span className="meta-divider" /><span className="meta-muted">Started {relativeTime(run.startedAt)}</span></div><div className="budget"><span>Budget</span><strong>{run.tokens.toLocaleString()} / {run.budget.toLocaleString()} tokens</strong><div className="budget-track"><span style={{ width: `${Math.min(100, (run.tokens / run.budget) * 100)}%` }} /></div></div></div>
    <div className="run-grid">
      <section className="panel phases-panel"><div className="panel-heading"><div><span className="panel-kicker">Execution plan</span><h2>Phases</h2></div><span className="progress-label">{passedCount}/{project.phases.length} passed</span></div><div className="phase-list">{project.phases.map((phase: any, index: number) => { const done = phase.status === "passed"; const current = phase.index === run.phaseIndex; return <button className={`phase-item ${current ? "current" : ""}`} key={phase.id} onClick={() => setActiveEvent(allEvents.find((event: any) => event.phaseId === phase.id)?.id ?? null)}><div className="phase-rail"><div className={`phase-node ${done ? "done" : current ? "active" : ""}`}>{done ? <Check size={13} /> : phase.index}</div>{index < project.phases.length - 1 ? <div className={`phase-line ${done ? "filled" : ""}`} /> : null}</div><div className="phase-content"><div className="phase-title-row"><strong>{phase.name}</strong><StatusTag status={phase.status} /></div><p>{phase.summary}</p><div className="phase-foot"><span><GitBranch size={12} /> {phase.branch.replace("meadow/", "")}</span><span>{phase.attempts || 0} {phase.attempts === 1 ? "attempt" : "attempts"}</span></div></div></button>; })}</div><div className="phase-summary"><div className="summary-ring"><span>{progress}%</span></div><div><strong>{passedCount === project.phases.length ? "Ready to ship" : "Work is in motion"}</strong><span>{passedCount} phase{passedCount === 1 ? "" : "s"} have their receipts.</span></div></div></section>
      <section className="panel events-panel"><div className="panel-heading event-heading"><div><span className="panel-kicker">Live event stream</span><h2>What Meadow is doing</h2></div><div className="event-count"><span className="pulse-dot" /> {events.length} events</div></div><div className="filter-row"><div className="filter-tabs">{["All events", "Checks", "Files"].map(filter => <button key={filter} className={eventFilter === filter ? "selected" : ""} onClick={() => setEventFilter(filter)}>{filter}</button>)}</div><button className="icon-button small" aria-label="Event options"><MoreHorizontal size={16} /></button></div><div className="event-list">{events.slice().reverse().map((event: any) => { const Icon = eventIcons[event.type] ?? CircleDot; const selected = activeEvent === event.id; return <button className={`event-row ${selected ? "selected" : ""}`} key={event.id} onClick={() => setActiveEvent(event.id)}><div className={`event-icon event-${event.type}`}><Icon size={14} /></div><div className="event-copy"><div className="event-title"><strong>{event.title}</strong><time>{clockTime(event.ts)}</time></div><p>{event.detail}</p><div className="event-meta">{event.meta ? <span className="evidence-chip">{event.meta}</span> : null}{event.phaseId ? <span>Phase {project.phases.find((phase: any) => phase.id === event.phaseId)?.index}</span> : null}</div></div></button>; })}</div><button className="stream-footer"><History size={14} /> Replay from event 1 <ArrowDownRight size={14} /></button></section>
      <section className="panel inspector-panel"><div className="panel-heading"><div><span className="panel-kicker">Selected evidence</span><h2>{inspectorTab}</h2></div><button className="icon-button small"><Copy size={14} /></button></div><div className="inspector-tabs">{["Diff", "Checks", "Screenshots", "Prompt"].map(tab => <button className={inspectorTab === tab ? "selected" : ""} key={tab} onClick={() => setInspectorTab(tab)}>{tab}</button>)}</div><InspectorContent tab={inspectorTab} project={project} run={run} /></section>
    </div>
  </>;
}

function InspectorContent({ tab, project, run }: any) {
  if (tab === "Diff") return <div className="inspector-body"><div className="inspector-stat-row"><div><span>Changed files</span><strong>{run.changedFiles}</strong></div><div><span>Net lines</span><strong className="positive">+138</strong></div></div><div className="diff-list">{run.diff.map((file: any) => <div className="diff-file" key={file.path}><div className={`file-kind ${file.kind}`}>{file.kind === "added" ? "A" : "M"}</div><span>{file.path}</span><div className="diff-numbers"><b>+{file.additions}</b><em>−{file.deletions}</em></div></div>)}</div><div className="code-preview"><div className="code-line"><span>38</span><i>+</i><code><b>await</b> verifier.run(checks, timeout=60)</code></div><div className="code-line"><span>39</span><i>+</i><code><b>return</b> PhaseResult.passed()</code></div><div className="code-line dim"><span>40</span><i> </i><code></code></div><div className="code-line"><span>41</span><i>+</i><code><b>emit</b>(ScreenshotCaptured(path))</code></div></div></div>;
  if (tab === "Checks") return <div className="inspector-body check-stack">{project.phases.map((phase: any) => phase.checks.map((check: any) => <div className="check-row" key={`${phase.id}-${check.command}`}><div className={`check-state ${check.status}`}><Check size={12} /></div><div><strong>{check.label}</strong><code>{check.command}</code></div><span className={`check-status ${check.status}`}>{check.status}</span></div>))}</div>;
  if (tab === "Screenshots") return <div className="inspector-body"><div className="shot-preview"><div className="shot-window"><div className="shot-top"><span /><span /><span /></div><div className="shot-content"><div className="shot-nav" /><div className="shot-main"><div /><div /><div /></div></div></div></div><div className="shot-caption"><div><strong>dashboard / desktop</strong><span>1280 × 800 · captured 2m ago</span></div><button className="button tiny secondary">Open</button></div><div className="shot-preview muted-shot"><div className="shot-placeholder"><WandSparkles size={17} /><span>Mobile capture queued</span></div></div></div>;
  return <div className="inspector-body prompt-body"><div className="prompt-label"><span>phase.md · compiled prompt</span><span className="evidence-chip">cursor</span></div><pre>{`# Role\nYou are working inside an existing git repository.\n\n# This phase: ${project.phases[2]?.name ?? "Run harness"}\nTasks:\n- Make the runner recoverable\n- Keep work inside the project root\n- Run every acceptance check\n\n# Done when\n${project.phases[2]?.summary ?? "The phase checks pass."}\n\n# Acceptance checks\npnpm test -- harness\nGET /api/health`}</pre></div>;
}

function StatusTag({ status }: { status: string }) { const labels: Record<string, string> = { passed: "Passed", running: "Running", queued: "Queued", paused: "Paused", blocked: "Blocked", stopped: "Stopped", ready: "Ready" }; return <span className={`status-tag ${status}`}><span />{labels[status] ?? status}</span>; }

function ProjectsView({ projects, onNew, onOpen }: any) { return <><PageHeader eyebrow="Workspace registry" title="Projects" description="Every project has its own plan, branches, checks, and recoverable run history." action={<button className="button primary" onClick={onNew}><Plus size={16} /> New project</button>} /><div className="project-stats"><Metric icon={Boxes} label="Projects" value={projects.length} trend="+1 this month" /><Metric icon={Activity} label="Active runs" value={projects.filter((project: any) => project.status === "running").length} trend="Across local roots" /><Metric icon={CheckCircle2} label="Pass rate" value="96%" trend="Last 30 phases" /><Metric icon={Clock3} label="Avg. phase" value="8m" trend="−2m vs. last week" /></div><div className="project-grid">{projects.map((project: any) => <button className="project-card" key={project.id} onClick={() => onOpen(project.id)}><div className="project-card-top"><div className="project-symbol"><Leaf size={20} /></div><StatusTag status={project.status} /></div><div className="project-name">{project.name}</div><p>{project.description}</p><div className="project-meta"><span><FolderGit2 size={13} /> {project.path}</span><span><Bot size={13} /> {project.engine}</span></div><div className="project-card-divider" /><div className="project-card-footer"><span>Phase {project.currentPhase} of {project.phases.length}</span><span>{relativeTime(project.updatedAt)}</span></div><div className="mini-progress"><span style={{ width: `${(project.phases.filter((phase: any) => phase.status === "passed").length / project.phases.length) * 100}%` }} /></div></button>)}<button className="new-project-card" onClick={onNew}><div className="new-project-icon"><Plus size={18} /></div><strong>Start another project</strong><span>Connect a new local root and plan.</span></button></div></>; }

function Metric({ icon: Icon, label, value, trend }: { icon: LucideIcon; label: string; value: string | number; trend: string }) { return <div className="metric-card"><div className="metric-icon"><Icon size={16} /></div><span>{label}</span><strong>{value}</strong><small>{trend}</small></div>; }

function PlanView({ plan, setPlan, onValidate, result }: any) { return <><PageHeader eyebrow="Plan system · version 3" title="Make the work legible." description="Plans are contracts: each phase needs a check, a done condition, and a clear dependency graph." action={<div className="header-actions"><button className="button secondary"><History size={15} /> Version history</button><button className="button primary" onClick={onValidate}><CheckCircle2 size={15} /> Validate plan</button></div>} /><div className="plan-layout"><section className="panel editor-panel"><div className="editor-top"><div><span className="panel-kicker">PLAN.md · draft</span><h2>Markdown editor</h2></div><span className="saved-label"><span className="saved-dot" /> Autosaved just now</span></div><textarea value={plan} onChange={event => setPlan(event.target.value)} spellCheck={false} className="plan-editor" />{result ? <div className={`validation-result ${result.valid ? "valid" : "invalid"}`}><span>{result.valid ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}</span><div><strong>{result.valid ? `Plan valid · ${result.phaseCount} phases detected` : "Plan needs attention"}</strong><span>{result.errors.length ? result.errors.join(" ") : "Every phase includes a runnable check."}</span></div></div> : <div className="editor-hint"><Command size={14} /> Markdown is the source of truth. Changes create a new plan version when approved.</div>}</section><section className="panel plan-outline"><div className="panel-heading"><div><span className="panel-kicker">Validated structure</span><h2>Phase graph</h2></div><span className="graph-count">3 phases</span></div><div className="graph-list"><GraphPhase num="1" title="Foundation & shell" status="passed" /><div className="graph-connector" /><GraphPhase num="2" title="Projects & state" status="passed" /><div className="graph-connector" /><GraphPhase num="3" title="Run harness" status="running" /></div><div className="outline-foot"><Network size={14} /><span>DAG valid · no circular dependencies</span></div></section></div></>; }
function GraphPhase({ num, title, status }: { num: string; title: string; status: string }) { return <div className={`graph-phase ${status}`}><div className="graph-node">{status === "passed" ? <Check size={13} /> : num}</div><div><strong>{title}</strong><span>{status === "passed" ? "2 checks · passed" : "2 checks · in progress"}</span></div><MoreHorizontal size={15} /></div>; }

function ApprovalsView({ approvals, onDecide }: any) { const pending = approvals.filter((item: any) => item.status === "pending"); const past = approvals.filter((item: any) => item.status !== "pending"); return <><PageHeader eyebrow="Safety gate" title="Approvals" description="Meadow asks before risky actions leave the project boundary or touch a remote system." action={<div className="approval-summary"><ShieldCheck size={15} /><strong>{pending.length} pending</strong></div>} /><div className="approval-layout"><section><div className="section-label">Needs your decision</div>{pending.length ? pending.map((approval: any) => <ApprovalCard key={approval.id} approval={approval} onDecide={onDecide} />) : <EmptyState icon={CheckCircle2} title="Nothing waiting" body="The harness is clear to continue." />}</section><section><div className="section-label">Decision history</div>{past.map((approval: any) => <ApprovalCard key={approval.id} approval={approval} onDecide={onDecide} />)}</section></div></>; }
function ApprovalCard({ approval, onDecide }: any) { const pending = approval.status === "pending"; return <div className={`approval-card ${pending ? "pending" : "past"}`}><div className="approval-icon"><ShieldCheck size={18} /></div><div className="approval-main"><div className="approval-title-row"><div><strong>{approval.title}</strong><span>{relativeTime(approval.requestedAt)}</span></div><span className={`risk-tag ${approval.risk}`}>{approval.risk} risk</span></div><p>{approval.detail}</p>{pending ? <div className="approval-actions"><button className="button secondary" onClick={() => onDecide(approval.id, "denied")}><X size={14} /> Deny</button><button className="button primary" onClick={() => onDecide(approval.id, "approved")}><Check size={14} /> Approve</button></div> : <div className={`decision ${approval.status}`}><Check size={13} /> {approval.status} by you</div>}</div></div>; }

function MemoryView({ notes, search, setSearch, showForm, setShowForm, newNote, setNewNote, onAdd }: any) { const filtered = notes.filter((note: any) => `${note.title} ${note.body} ${note.source}`.toLowerCase().includes(search.toLowerCase())); return <><PageHeader eyebrow="Project memory" title="Remember the context." description="Meadow indexes project rules and phase summaries so every prompt starts from the same shared understanding." action={<div className="header-actions"><button className="button secondary"><RotateCcw size={15} /> Re-index</button><button className="button primary" onClick={() => setShowForm(!showForm)}><Plus size={15} /> Add note</button></div>} /><div className="memory-toolbar"><div className="search-field"><Search size={16} /><input placeholder="Search memory and indexed sources" value={search} onChange={event => setSearch(event.target.value)} /></div><div className="memory-sources"><span className="source-dot" /> 18 sources indexed <span className="meta-divider" /> last indexed 4m ago</div></div>{showForm ? <div className="panel add-note-form"><div><span className="panel-kicker">New memory</span><h2>Leave a note for the next run</h2></div><input placeholder="Title" value={newNote.title} onChange={event => setNewNote({ ...newNote, title: event.target.value })} /><textarea placeholder="What should Meadow remember?" value={newNote.body} onChange={event => setNewNote({ ...newNote, body: event.target.value })} /><div className="form-actions"><button className="button secondary" onClick={() => setShowForm(false)}>Cancel</button><button className="button primary" onClick={onAdd} disabled={!newNote.title || !newNote.body}>Save note</button></div></div> : null}<div className="memory-grid">{filtered.map((note: any) => <article className="memory-card" key={note.id}><div className="memory-card-head"><div className="memory-type"><BookOpen size={14} /> Note</div><button className="icon-button small"><MoreHorizontal size={15} /></button></div><h3>{note.title}</h3><p>{note.body}</p><div className="memory-card-foot"><span><FileText size={12} /> {note.source}</span><span>{relativeTime(note.updatedAt)}</span></div></article>)}</div></>; }

function SettingsView({ settings, doctor, onSave, saving }: any) { return <><PageHeader eyebrow="Workspace settings" title="Tune the guardrails." description="Meadow stays useful when the defaults are clear: local boundaries, quiet notifications, and budgets you can see." action={<button className="button primary" onClick={() => onSave({ notificationLevel: settings.notificationLevel, screenshotEnabled: settings.screenshotEnabled, budget: settings.budget })}><Check size={15} /> {saving ? "Saving…" : "Save changes"}</button>} /><div className="settings-grid"><section className="panel settings-section"><div className="settings-section-head"><div className="settings-section-icon"><Bot size={17} /></div><div><h2>Engine adapters</h2><p>Free engines are the default. Paid adapters stay opt-in.</p></div><span className="settings-check"><CheckCircle2 size={14} /> Doctor ran just now</span></div><div className="engine-list">{doctor.map((engine: any) => <div className="engine-row" key={engine.name}><div className="engine-symbol"><Terminal size={15} /></div><div><strong>{engine.name}</strong><span>{engine.detail}</span></div><StatusTag status={engine.state === "ready" ? "passed" : "queued"} /></div>)}</div></section><section className="panel settings-section"><div className="settings-section-head"><div className="settings-section-icon"><Bell size={17} /></div><div><h2>Notifications</h2><p>Choose how much of the event stream reaches Telegram.</p></div></div><div className="setting-control"><div><strong>Notification level</strong><span>Quiet hours queue non-urgent messages.</span></div><select value={settings.notificationLevel} onChange={event => onSave({ notificationLevel: event.target.value as any })}><option value="all">All events</option><option value="phases">Phase ends</option><option value="failures">Failures only</option></select></div><div className="setting-control"><div><strong>Quiet hours</strong><span>Pause non-urgent sends from 22:00 to 08:00.</span></div><Toggle checked={settings.quietHours} onChange={checked => onSave({ quietHours: checked })} /></div></section><section className="panel settings-section"><div className="settings-section-head"><div className="settings-section-icon"><Zap size={17} /></div><div><h2>Budgets & previews</h2><p>Runaway loops should be visible before they become expensive.</p></div></div><div className="setting-control"><div><strong>Token budget</strong><span>Default cap for a single run.</span></div><div className="number-input"><input type="number" value={settings.budget} onChange={event => onSave({ budget: Number(event.target.value) })} /><span>tokens</span></div></div><div className="setting-control"><div><strong>Capture screenshots</strong><span>Only project routes are captured; desktop and mobile.</span></div><Toggle checked={settings.screenshotEnabled} onChange={checked => onSave({ screenshotEnabled: checked })} /></div></section><section className="panel settings-section danger-section"><div className="settings-section-head"><div className="settings-section-icon danger"><AlertTriangle size={17} /></div><div><h2>Danger zone</h2><p>Export a run bundle before wiping local Meadow state.</p></div></div><div className="danger-actions"><button className="button secondary"><UploadCloud size={15} /> Export run data</button><button className="button danger"><Trash2 size={15} /> Wipe local data</button></div></section></div></>; }
function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) { return <button className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked}><span /></button>; }
function EmptyState({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) { return <div className="empty-state"><Icon size={22} /><strong>{title}</strong><span>{body}</span></div>; }

function NewProjectDialog({ value, setValue, onClose, onCreate, saving }: any) { return <div className="dialog-overlay"><div className="dialog"><div className="dialog-head"><div><span className="eyebrow">New local project</span><h2>Give the work a home.</h2></div><button className="icon-button" onClick={onClose}><X size={17} /></button></div><label>Project name<input autoFocus value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} placeholder="e.g. bakery-site" /></label><label>Engine<select value={value.engine} onChange={event => setValue({ ...value, engine: event.target.value })}><option>Cursor CLI</option><option>Claude Code</option><option>Gemini CLI</option><option>OpenCode</option></select></label><label>Description<textarea value={value.description} onChange={event => setValue({ ...value, description: event.target.value })} placeholder="What are you building?" /></label><div className="dialog-foot"><span><ShieldCheck size={14} /> Local root only</span><div><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" onClick={onCreate} disabled={!value.name || saving}>{saving ? "Creating…" : "Create project"}</button></div></div></div></div>; }

export default App;
