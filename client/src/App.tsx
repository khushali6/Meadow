import { Toaster } from "@/components/ui/sonner";
import { Activity, BookOpen, Boxes, ChevronDown, FileText, FolderGit2, KeyRound, Leaf, Menu, MessageSquarePlus, Moon, Settings2, ShieldCheck, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { EmptyState } from "./components/common";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { saveToken, useLiveEvents, useUnauthorized, type LiveEvent } from "./lib/api";
import { trpc } from "./lib/trpc";
import { ApprovalsView } from "./views/ApprovalsView";
import { MemoryView } from "./views/MemoryView";
import { PlanView } from "./views/PlanView";
import { ProjectsView } from "./views/ProjectsView";
import { RequestView } from "./views/RequestView";
import { RunView } from "./views/RunView";
import { SettingsView } from "./views/SettingsView";

const NAV = [
  { key: "/", label: "Run view", icon: Activity, needsProject: true },
  { key: "/request", label: "New request", icon: MessageSquarePlus },
  { key: "/projects", label: "Projects", icon: Boxes },
  { key: "/plans", label: "Plan editor", icon: FileText, needsProject: true },
  { key: "/approvals", label: "Approvals", icon: ShieldCheck, badge: true },
  { key: "/memory", label: "Memory", icon: BookOpen },
] as const;

const PROJECT_KEY = "meadow-project";
const TOASTED = new Set(["phase_passed", "phase_blocked", "approval_requested", "execution_finished", "plan_ready"]);

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable>
        <Toaster position="bottom-right" />
        <Shell />
      </ThemeProvider>
    </ErrorBoundary>
  );
}

function Shell() {
  const unauthorized = useUnauthorized();
  if (unauthorized) return <SessionExpired />;
  return <Dashboard />;
}

function SessionExpired() {
  const [value, setValue] = useState("");
  return (
    <div className="loading-screen">
      <div className="brand-mark"><Leaf size={20} /></div>
      <strong className="session-title">This dashboard session has ended</strong>
      <span className="session-copy">Meadow makes a new session token every time it starts. Open the link printed by <code>meadow start</code>, or paste the token from <code>~/.meadow/session-token</code>.</span>
      <form className="search-row session-form" onSubmit={event => { event.preventDefault(); if (value.trim()) saveToken(value); }}>
        <input type="password" value={value} onChange={event => setValue(event.target.value)} placeholder="Session token" aria-label="Session token" autoFocus />
        <button className="button primary"><KeyRound size={14} /> Continue</button>
      </form>
    </div>
  );
}

function Dashboard() {
  const [location, navigate] = useLocation();
  const [mobileNav, setMobileNav] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [projectId, setProjectId] = useState<number | null>(() => Number(localStorage.getItem(PROJECT_KEY)) || null);
  const { theme, toggleTheme } = useTheme();
  const utils = trpc.useUtils();

  const overview = trpc.overview.useQuery(undefined, { refetchInterval: 15000 });
  const settings = trpc.settings.useQuery();
  const projects = overview.data?.projects ?? [];
  const project = projects.find(item => item.id === projectId) ?? projects[0];
  const detail = trpc.project.useQuery({ id: project?.id ?? 0 }, { enabled: Boolean(project), refetchInterval: 10000 });
  const pendingApprovals = overview.data?.approvals.filter(item => item.status === "pending").length ?? 0;

  useEffect(() => {
    if (project && project.id !== projectId) setProjectId(project.id);
  }, [project?.id]);

  useEffect(() => {
    if (projectId) localStorage.setItem(PROJECT_KEY, String(projectId));
  }, [projectId]);

  const onEvent = useCallback((event: LiveEvent) => {
    utils.project.invalidate();
    if (["approval_requested", "approval_decided", "execution_started", "execution_finished", "phase_passed", "phase_blocked", "plan_ready", "control"].includes(event.type)) utils.overview.invalidate();
    if (TOASTED.has(event.type) && Date.now() - new Date(event.ts).getTime() < 20_000) {
      const show = event.type === "phase_blocked" ? toast.error : event.type === "approval_requested" ? toast.warning : toast.success;
      show(event.title, { description: event.detail.split("\n")[0]?.slice(0, 160) });
    }
  }, [utils]);
  const connected = useLiveEvents(onEvent);

  const go = (path: string) => { setMobileNav(false); setSwitcher(false); navigate(path); };
  const openProject = (id: number, path = "/") => { setProjectId(id); go(path); };
  const current = NAV.find(item => item.key === location) ?? (location === "/settings" ? { label: "Settings" } : { label: "Run view" });

  if (overview.isLoading) return <div className="loading-screen"><div className="brand-mark"><Leaf size={20} /></div><span>Connecting to the local Meadow daemon…</span></div>;
  if (overview.error) return <div className="loading-screen"><div className="brand-mark"><Leaf size={20} /></div><span>Can't reach the Meadow daemon: {overview.error.message}</span><button className="button secondary" onClick={() => overview.refetch()}>Try again</button></div>;

  const needsProject = (location === "/" || location === "/plans") && !project;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand-lockup" onClick={() => go("/")} role="button" tabIndex={0} onKeyDown={event => event.key === "Enter" && go("/")}>
          <div className="brand-mark"><Leaf size={17} strokeWidth={2.4} /></div>
          <div><div className="brand-name">meadow</div><div className="brand-tagline">local-first agent</div></div>
        </div>
        <div className="switcher-wrap">
          <button className="workspace-switcher" onClick={() => setSwitcher(!switcher)} aria-expanded={switcher} disabled={!projects.length}>
            <div className="workspace-icon"><FolderGit2 size={16} /></div>
            <div className="workspace-copy"><strong>{project?.name ?? "No project yet"}</strong><span>{project ? `${project.engine} · ${project.status}` : "Create one to begin"}</span></div>
            <ChevronDown size={15} className="muted-icon" />
          </button>
          {switcher ? (
            <div className="switcher-menu" role="menu">
              {projects.map(item => <button key={item.id} role="menuitem" className={item.id === project?.id ? "active" : ""} onClick={() => openProject(item.id, location)}>{item.name}<span>{item.status}</span></button>)}
            </div>
          ) : null}
        </div>
        <div className="nav-label">Workspace</div>
        <nav className="main-nav">
          {NAV.map(item => (
            <button key={item.key} className={`nav-item ${location === item.key ? "active" : ""}`} onClick={() => go(item.key)} aria-current={location === item.key ? "page" : undefined}>
              <item.icon size={17} /><span>{item.label}</span>
              {"badge" in item && pendingApprovals > 0 ? <b className="nav-badge">{pendingApprovals}</b> : null}
            </button>
          ))}
        </nav>
        <div className="nav-label nav-label-spaced">System</div>
        <nav className="main-nav">
          <button className={`nav-item ${location === "/settings" ? "active" : ""}`} onClick={() => go("/settings")}><Settings2 size={17} /><span>Settings</span></button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="safety-card"><div className="safety-icon"><ShieldCheck size={15} /></div><div><strong>Local boundary active</strong><span>Dashboard on 127.0.0.1 only. Engines work inside the project folder.</span></div></div>
      </aside>
      {mobileNav ? <button className="mobile-overlay" onClick={() => setMobileNav(false)} aria-label="Close navigation" /> : null}
      <main className="main-canvas">
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={19} /></button>
          <div className="breadcrumb"><span>Meadow</span><span className="crumb-separator">/</span>{project && (location === "/" || location === "/plans" || location === "/memory") ? <><span>{project.name}</span><span className="crumb-separator">/</span></> : null}<strong>{current.label}</strong></div>
          <div className="topbar-actions">
            <div className={`status-inline ${connected ? "" : "offline"}`}>{connected ? <span className="pulse-dot" /> : <span className="offline-dot" />}<span>{connected ? "Live" : "Reconnecting…"}</span></div>
            <button className="icon-button" onClick={() => toggleTheme?.()} aria-label="Toggle theme">{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button>
          </div>
        </header>
        <div className="page-wrap">
          {needsProject ? (
            <EmptyState icon={Boxes} title="No projects yet" body="Describe what you want to build, or create an empty project and write a plan." action={<div className="header-actions"><button className="button secondary" onClick={() => go("/projects")}>New project</button><button className="button primary" onClick={() => go("/request")}>New request</button></div>} />
          ) : null}
          {location === "/" && project ? (detail.data ? <RunView key={project.id} detail={detail.data} onNavigate={go} /> : <div className="event-empty">Loading {project.name}…</div>) : null}
          {location === "/plans" && project ? (detail.data ? <PlanView key={project.id} detail={detail.data} onNavigate={go} /> : <div className="event-empty">Loading plan…</div>) : null}
          {location === "/request" ? <RequestView onNavigate={go} /> : null}
          {location === "/projects" ? <ProjectsView projects={projects} settings={settings.data} activeId={project?.id ?? null} onOpen={openProject} /> : null}
          {location === "/approvals" ? <ApprovalsView approvals={overview.data?.approvals ?? []} projects={projects} /> : null}
          {location === "/memory" ? <MemoryView key={project?.id ?? 0} project={project} /> : null}
          {location === "/settings" ? <SettingsView settings={settings.data} overview={overview.data} project={project} /> : null}
          {!["/", "/plans", "/request", "/projects", "/approvals", "/memory", "/settings"].includes(location) ? <EmptyState icon={Leaf} title="Page not found" body="That page doesn't exist." action={<button className="button primary" onClick={() => go("/")}>Back to the run view</button>} /> : null}
        </div>
      </main>
    </div>
  );
}
