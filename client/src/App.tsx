import { Toaster } from "@/components/ui/sonner";
import { Activity, BookOpen, Boxes, Network, Radar, ChevronDown, FileText, FolderGit2, KeyRound, Leaf, Menu, MessageSquarePlus, Moon, Settings2, ShieldCheck, Sun } from "lucide-react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { MotionConfig } from "motion/react";
import { motion, MotionButton } from "./components/animation/motion";
import { ActivityDot } from "./components/animation/technical";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { EmptyState } from "./components/common";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { saveToken, useLiveEvents, useUnauthorized, type LiveEvent } from "./lib/api";
import { trpc } from "./lib/trpc";
import { ApprovalsView } from "./views/ApprovalsView";
import { InvestigateView } from "./views/InvestigateView";
import { MemoryView } from "./views/MemoryView";
import { PlanView } from "./views/PlanView";
import { ProjectsView } from "./views/ProjectsView";
import { RequestView } from "./views/RequestView";
import { RunView } from "./views/RunView";
import { SettingsView } from "./views/SettingsView";

gsap.registerPlugin(useGSAP);
gsap.defaults({ ease: "power3.out", duration: 0.55 });

const SystemMapView = lazy(() => import("./views/SystemMapView").then(module => ({ default: module.SystemMapView })));

const NAV = [
  { key: "/", label: "Live console", icon: Activity },
  { key: "/request", label: "New request", icon: MessageSquarePlus },
  { key: "/projects", label: "Workspaces", icon: Boxes },
  { key: "/plans", label: "Execution plan", icon: FileText },
  { key: "/approvals", label: "Policy gates", icon: ShieldCheck, badge: true },
  { key: "/memory", label: "Context index", icon: BookOpen },
  { key: "/atlas", label: "CodeAtlas", icon: Radar },
  { key: "/map", label: "System map", icon: Network },
] as const;

const PROJECT_KEY = "meadow-project";
const TOASTED = new Set(["phase_passed", "phase_blocked", "approval_requested", "execution_finished", "plan_ready"]);

export default function App() {
  return (
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
        <ThemeProvider defaultTheme="light" switchable>
          <Toaster position="bottom-right" />
          <Shell />
        </ThemeProvider>
      </MotionConfig>
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
        <MotionButton className="button primary"><KeyRound size={14} /> Continue</MotionButton>
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
  const shellRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const overview = trpc.overview.useQuery(undefined, { refetchInterval: 15000 });
  const settings = trpc.settings.useQuery();
  const projects = overview.data?.projects ?? [];
  const project = projects.find(item => item.id === projectId) ?? projects[0];
  const detail = trpc.project.useQuery({ id: project?.id ?? 0 }, { enabled: Boolean(project), refetchInterval: 10000 });
  const anyRunning = projects.some(item => item.status === "running");
  const pendingApprovals = overview.data?.approvals.filter(item => item.status === "pending").length ?? 0;

  useEffect(() => {
    if (project && project.id !== projectId) setProjectId(project.id);
  }, [project?.id]);

  useEffect(() => {
    if (projectId) localStorage.setItem(PROJECT_KEY, String(projectId));
  }, [projectId]);

  const onEvent = useCallback((event: LiveEvent) => {
    if (event.type === "atlas_trace") {
      utils.atlas.investigation.invalidate();
      return;
    }
    if (event.type === "atlas_ingest") {
      utils.atlas.status.invalidate();
      if (event.payload?.step === "done") {
        utils.atlas.map.invalidate();
        toast.success(event.title, { description: event.detail });
      }
      return;
    }
    utils.project.invalidate();
    if (event.type === "approval_decided") utils.atlas.actions.invalidate();
    if (["approval_requested", "approval_decided", "execution_started", "execution_finished", "phase_passed", "phase_blocked", "plan_ready", "control"].includes(event.type)) utils.overview.invalidate();
    if (TOASTED.has(event.type) && Date.now() - new Date(event.ts).getTime() < 20_000) {
      const show = event.type === "phase_blocked" ? toast.error : event.type === "approval_requested" ? toast.warning : toast.success;
      show(event.title, { description: event.detail.split("\n")[0]?.slice(0, 160) });
    }
  }, [utils]);
  const connected = useLiveEvents(onEvent);

  const ready = Boolean(overview.data);

  useGSAP(() => {
    if (!shellRef.current) return;
    const mm = gsap.matchMedia();
    mm.add({ reduceMotion: "(prefers-reduced-motion: reduce)", compact: "(max-width: 820px)" }, context => {
      const { reduceMotion, compact } = context.conditions as { reduceMotion: boolean; compact: boolean };
      const duration = reduceMotion ? 0 : compact ? 0.38 : 0.62;
      const intro = gsap.timeline({ defaults: { duration, ease: "power3.out" } });
      if (!compact) intro.from(".sidebar", { x: -18, autoAlpha: 0, ease: "power2.out", clearProps: "transform" }, 0);
      intro.from(".topbar", { y: -10, autoAlpha: 0 }, compact ? 0 : "<0.08")
        .from(".page-header .eyebrow", { y: 14, autoAlpha: 0 }, "<0.12")
        .from(".page-header h1", { y: 28, autoAlpha: 0, clipPath: "inset(0 0 100% 0)" }, "<0.06")
        .from(".page-header p", { y: 14, autoAlpha: 0 }, "<0.16")
        .from(".run-meta-row, .memory-toolbar", { y: 14, autoAlpha: 0 }, "<0.1")
        .from(".panel, .project-card, .new-project-card, .settings-section", { y: 18, autoAlpha: 0, stagger: 0.045 }, "<0.08");
      if (reduceMotion) intro.progress(1);
      return () => intro.kill();
    });
    return () => mm.revert();
  }, { scope: shellRef, dependencies: [ready], revertOnUpdate: true });

  useGSAP(() => {
    if (!pageRef.current) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const transition = gsap.timeline({ defaults: { duration: reduceMotion ? 0 : 0.34, ease: "power2.out" } });
    transition.fromTo(pageRef.current, { autoAlpha: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : 10 }, { autoAlpha: 1, y: 0, clearProps: "transform" });
    return () => transition.kill();
  }, { scope: pageRef, dependencies: [location, ready], revertOnUpdate: true });

  const go = (path: string) => { setMobileNav(false); setSwitcher(false); navigate(path); };
  const openProject = (id: number, path = "/") => { setProjectId(id); go(path); };
  const current = NAV.find(item => item.key === location) ?? (location === "/settings" ? { label: "Runtime settings" } : { label: "Live console" });

  if (overview.isLoading) return <div className="loading-screen"><div className="brand-mark"><Leaf size={20} /></div><span>Connecting to the local Meadow daemon…</span></div>;
  if (overview.error) return <div className="loading-screen"><div className="brand-mark"><Leaf size={20} /></div><span>Can't reach the Meadow daemon: {overview.error.message}</span><MotionButton className="button secondary" onClick={() => overview.refetch()}>Try again</MotionButton></div>;

  const needsProject = (location === "/" || location === "/plans") && !project;

  return (
    <div className="app-shell" ref={shellRef}>
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
        <div className="nav-label">Control plane</div>
        <nav className="main-nav">
          {NAV.map(item => (
            <button key={item.key} className={`nav-item ${location === item.key ? "active" : ""}`} onClick={() => go(item.key)} aria-current={location === item.key ? "page" : undefined}>
              {location === item.key ? <motion.span layoutId="nav-indicator" className="nav-indicator" transition={{ type: "spring", stiffness: 520, damping: 40 }} /> : null}
              <item.icon size={17} /><span>{item.label}</span>
              {"badge" in item && pendingApprovals > 0 ? <b className="nav-badge">{pendingApprovals}</b> : null}
            </button>
          ))}
        </nav>
        <div className="nav-label nav-label-spaced">Runtime</div>
        <nav className="main-nav">
          <button className={`nav-item ${location === "/settings" ? "active" : ""}`} onClick={() => go("/settings")}>{location === "/settings" ? <motion.span layoutId="nav-indicator" className="nav-indicator" transition={{ type: "spring", stiffness: 520, damping: 40 }} /> : null}<Settings2 size={17} /><span>Runtime settings</span></button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="safety-card"><div className="safety-icon"><ShieldCheck size={15} /></div><div><strong>Local only</strong><span>Dashboard on 127.0.0.1. Engines work inside the project folder.</span></div></div>
      </aside>
      {mobileNav ? <button className="mobile-overlay" onClick={() => setMobileNav(false)} aria-label="Close navigation" /> : null}
      <main className="main-canvas">
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={19} /></button>
          <div className="breadcrumb"><span>Meadow</span><span className="crumb-separator">/</span>{project && (location === "/" || location === "/plans" || location === "/memory" || location === "/atlas" || location === "/map") ? <><span>{project.name}</span><span className="crumb-separator">/</span></> : null}<strong>{current.label}</strong></div>
          <div className="topbar-actions">
            <div className={`status-inline ${connected ? "" : "offline"}`}><ActivityDot active={connected && anyRunning} tone={connected ? "idle" : "error"} /><span>{connected ? (anyRunning ? "EXECUTING · 127.0.0.1" : "CONNECTED · 127.0.0.1") : "RECONNECTING…"}</span></div>
            <button className="icon-button" onClick={() => toggleTheme?.()} aria-label="Toggle theme">{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button>
          </div>
        </header>
        <div className="page-wrap" ref={pageRef}>
          {needsProject ? (
            <EmptyState icon={Boxes} title="No projects yet" body="Describe what you want to build, or create an empty project and write a plan." action={<div className="header-actions"><MotionButton className="button secondary" onClick={() => go("/projects")}>New project</MotionButton><MotionButton className="button primary" onClick={() => go("/request")}>New request</MotionButton></div>} />
          ) : null}
          {location === "/" && project ? (detail.data ? <RunView key={project.id} detail={detail.data} onNavigate={go} /> : <div className="event-empty">Loading {project.name}…</div>) : null}
          {location === "/plans" && project ? (detail.data ? <PlanView key={project.id} detail={detail.data} onNavigate={go} /> : <div className="event-empty">Loading plan…</div>) : null}
          {location === "/request" ? <RequestView onNavigate={go} /> : null}
          {location === "/projects" ? <ProjectsView projects={projects} settings={settings.data} activeId={project?.id ?? null} onOpen={openProject} /> : null}
          {location === "/approvals" ? <ApprovalsView approvals={overview.data?.approvals ?? []} projects={projects} /> : null}
          {location === "/memory" ? <MemoryView key={project?.id ?? 0} project={project} /> : null}
          {location === "/atlas" ? <InvestigateView key={project?.id ?? 0} project={project} onNavigate={go} /> : null}
          {location === "/map" ? <Suspense fallback={<div className="event-empty">Loading the system map…</div>}><SystemMapView key={project?.id ?? 0} project={project} onNavigate={go} /></Suspense> : null}
          {location === "/settings" ? <SettingsView settings={settings.data} overview={overview.data} project={project} /> : null}
          {!["/", "/plans", "/request", "/projects", "/approvals", "/memory", "/atlas", "/map", "/settings"].includes(location) ? <EmptyState icon={Leaf} title="Page not found" body="That page doesn't exist." action={<MotionButton className="button primary" onClick={() => go("/")}>Back to the live console</MotionButton>} /> : null}
        </div>
      </main>
    </div>
  );
}
