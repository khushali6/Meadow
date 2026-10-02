import { AnimatePresence } from "motion/react";
import { ArrowRight, CheckCircle2, CircleDot, Loader2, Plug, SkipForward, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { motion, MotionButton } from "../components/animation/motion";
import { ErrorNote } from "../components/common";
import { TelegramConnect, type Patch } from "../components/settingsParts";
import { trpc } from "../lib/trpc";
import type { Overview, Settings } from "../lib/types";

const STEPS = [
  { id: "repository", label: "Repository", title: "Point Meadow at your code." },
  { id: "llm", label: "Agent model", title: "Pick the model that plans." },
  { id: "codeatlas", label: "Knowledge", title: "Map the system." },
  { id: "mcp", label: "Tools", title: "Connect the tools you already use." },
  { id: "telegram", label: "Telegram", title: "Take it with you." },
  { id: "verify", label: "Verification", title: "Learn what “working” means." },
  { id: "plan", label: "First plan", title: "Decide what to do first." },
] as const;
type StepId = (typeof STEPS)[number]["id"];

function StepMark({ status, active }: { status: string | undefined; active: boolean }) {
  if (status === "running") return <Loader2 size={13} className="spin-slow" />;
  if (status === "done") return <CheckCircle2 size={13} />;
  if (status === "failed") return <XCircle size={13} />;
  if (status === "skipped") return <SkipForward size={13} />;
  return <CircleDot size={13} className={active ? "accent" : undefined} />;
}

export function WelcomeView({ settings, overview, onNavigate }: { settings: Settings | undefined; overview: Overview | undefined; onNavigate: (path: string) => void }) {
  const utils = trpc.useUtils();
  const state = trpc.setup.state.useQuery(undefined, { refetchInterval: query => (query.state.data?.running.length ? 1000 : false) });
  const [stepId, setStepId] = useState<StepId | null>(null);
  const steps = state.data?.steps ?? {};
  const projectId = state.data?.projectId ?? null;
  const firstOpen = useMemo(() => STEPS.find(step => !["done", "skipped"].includes(steps[step.id]?.status ?? ""))?.id ?? "plan", [steps]);
  const current = stepId ?? firstOpen;
  const index = STEPS.findIndex(step => step.id === current);
  const mark = trpc.setup.step.useMutation({ onSuccess: () => utils.setup.state.invalidate() });
  const next = () => setStepId(STEPS[Math.min(index + 1, STEPS.length - 1)].id);
  const skip = (id: StepId) => mark.mutate({ id, status: "skipped", detail: "Skipped" }, { onSuccess: next });
  const update = trpc.updateSettings.useMutation({ onSuccess: data => utils.settings.setData(undefined, data) });
  const patch = (value: Patch) => update.mutate(value);

  if (!state.data || !settings) return <div className="event-empty">Loading setup…</div>;
  const step = STEPS[index];
  return (
    <div className="welcome">
      <header className="welcome-head">
        <div className="eyebrow">00 / FIRST RUN</div>
        <h1>Install. Open a project. Approve a plan.</h1>
        <p>Meadow detects your stack, maps the code, learns how to verify it and drafts a first plan. Everything below runs on this computer; nothing executes without your approval.</p>
      </header>
      <div className="welcome-grid">
        <ol className="welcome-steps" aria-label="Setup steps">
          {STEPS.map((item, i) => {
            const status = steps[item.id]?.status;
            return (
              <li key={item.id}>
                <button className={`welcome-step ${item.id === current ? "active" : ""} ${status ?? "pending"}`} onClick={() => setStepId(item.id)} aria-current={item.id === current ? "step" : undefined}>
                  <span className="welcome-step-n">{String(i + 1).padStart(2, "0")}</span>
                  <span className="welcome-step-label">{item.label}</span>
                  <StepMark status={status} active={item.id === current} />
                </button>
                {steps[item.id]?.detail && status !== "pending" ? <span className="welcome-step-detail">{steps[item.id]!.detail}</span> : null}
              </li>
            );
          })}
        </ol>
        <section className="welcome-panel" aria-live="polite">
          <AnimatePresence mode="wait">
            <motion.div key={step.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
              <div className="welcome-panel-head">
                <span className="eyebrow">{String(index + 1).padStart(2, "0")} / {step.label.toUpperCase()}</span>
                <h2>{step.title}</h2>
              </div>
              {step.id === "repository" ? <RepositoryStep suggested={state.data.suggestedPath} projectId={projectId} onDone={next} /> : null}
              {step.id === "llm" ? <ProviderStep onDone={next} onSkip={() => skip("llm")} /> : null}
              {step.id === "codeatlas" ? <KnowledgeStep projectId={projectId} steps={steps} running={state.data.running} onDone={next} /> : null}
              {step.id === "mcp" ? <McpStep projectId={projectId} onDone={() => mark.mutate({ id: "mcp", status: "done", detail: "Reviewed" }, { onSuccess: next })} onSkip={() => skip("mcp")} /> : null}
              {step.id === "telegram" ? (
                <div className="welcome-body">
                  <p>Approve plans, get phase results with screenshots and send requests by voice. Connecting opens Telegram; tap Start and you're done.</p>
                  <div className="welcome-frame"><TelegramConnect tg={overview?.telegram} config={settings.config} hasOwnToken={settings.secrets.telegram} patch={patch} /></div>
                  <div className="welcome-actions">
                    <MotionButton className="button primary" onClick={() => mark.mutate({ id: "telegram", status: overview?.telegram.paired ? "done" : "skipped", detail: overview?.telegram.paired ? "Connected" : "Later" }, { onSuccess: next })}>{overview?.telegram.paired ? "Continue" : "Later"} <ArrowRight size={14} /></MotionButton>
                  </div>
                </div>
              ) : null}
              {step.id === "verify" ? <VerifyStep projectId={projectId} steps={steps} running={state.data.running} onDone={next} /> : null}
              {step.id === "plan" ? <PlanStep projectId={projectId} onFinish={path => onNavigate(path)} /> : null}
            </motion.div>
          </AnimatePresence>
          <ErrorNote error={mark.error ?? update.error} />
        </section>
      </div>
    </div>
  );
}

function RepositoryStep({ suggested, projectId, onDone }: { suggested: string | null; projectId: number | null; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState(suggested ?? "");
  const [target, setTarget] = useState(suggested ?? "");
  const detect = trpc.setup.detect.useQuery({ path: target }, { enabled: target.startsWith("/"), retry: false });
  const register = trpc.setup.register.useMutation({ onSuccess: () => { void utils.setup.state.invalidate(); void utils.overview.invalidate(); onDone(); } });
  return (
    <div className="welcome-body">
      <p>The full path to a repository on this machine. Meadow reads manifests, CI and editor configs to learn the stack; <code>.env</code> files and keys are never read.</p>
      <form className="search-row" onSubmit={event => { event.preventDefault(); setTarget(value.trim()); }}>
        <input className="text-input" value={value} onChange={event => setValue(event.target.value)} placeholder="/Users/you/code/my-app" aria-label="Repository path" spellCheck={false} />
        <MotionButton className="button secondary" disabled={!value.trim().startsWith("/")}>Detect</MotionButton>
      </form>
      <ErrorNote error={detect.error} />
      {detect.data ? (
        <ul className="detect-lines">
          {detect.data.lines.length ? detect.data.lines.map((line, i) => (
            <motion.li key={line} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05, duration: 0.2 }}><CheckCircle2 size={12} /> {line}</motion.li>
          )) : <li className="muted">Nothing recognisable here yet. Meadow can still work in an empty folder.</li>}
        </ul>
      ) : null}
      <div className="welcome-actions">
        <MotionButton className="button primary" disabled={!detect.data || register.isPending} onClick={() => register.mutate({ path: target })}>{register.isPending ? "Registering…" : "Use this repository"} <ArrowRight size={14} /></MotionButton>
        {projectId ? <MotionButton className="button secondary" onClick={onDone}>Keep current project</MotionButton> : null}
      </div>
      <ErrorNote error={register.error} />
    </div>
  );
}

function ProviderStep({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const utils = trpc.useUtils();
  const scan = trpc.setup.providers.useQuery(undefined, { refetchOnWindowFocus: false });
  const use = trpc.setup.useProvider.useMutation({ onSuccess: () => { void utils.setup.state.invalidate(); void utils.llm.providers.invalidate(); onDone(); } });
  if (scan.isLoading) return <div className="welcome-body"><p><Loader2 size={13} className="spin-slow" /> Looking for keys and local model servers…</p></div>;
  const providers = scan.data?.providers ?? [];
  return (
    <div className="welcome-body">
      <p>Used for planning, questions and summaries. Local servers on this machine are found automatically; cloud providers need an agent key. Memory and embeddings stay local either way.</p>
      <div className="provider-scan">
        {providers.map(provider => (
          <div key={provider.id} className={`provider-scan-row ${provider.available ? "ok" : ""} ${provider.id === scan.data?.recommended ? "recommended" : ""}`}>
            <span className="provider-scan-name">{provider.name}<em>{provider.type}</em></span>
            <span className="provider-scan-reason">{provider.reason}</span>
            {provider.available ? <MotionButton className={`button ${provider.id === scan.data?.recommended ? "primary" : "secondary"}`} disabled={use.isPending} onClick={() => use.mutate({ provider: provider.id, models: provider.models })}>{provider.id === scan.data?.recommended ? "Use (recommended)" : "Use"}</MotionButton> : <span className="status-tag queued"><span />{provider.needsKey ? "Key needed" : provider.type === "cloud" ? "No key" : "Not running"}</span>}
          </div>
        ))}
      </div>
      {scan.data?.note ? <p className="welcome-note">{scan.data.note}</p> : null}
      {providers.some(provider => !provider.available) ? <p className="welcome-note">Keys go in Runtime settings → Agent model, or in <code>~/.meadow/secrets.env</code>. Then scan again.</p> : null}
      <div className="welcome-actions">
        <MotionButton className="button secondary" onClick={() => scan.refetch()} disabled={scan.isFetching}>Scan again</MotionButton>
        <MotionButton className="button secondary" onClick={onSkip}>Continue without a model</MotionButton>
      </div>
      <ErrorNote error={use.error ?? scan.error} />
    </div>
  );
}

type Steps = Partial<Record<string, { status: string; detail: string }>>;

function KnowledgeStep({ projectId, steps, running, onDone }: { projectId: number | null; steps: Steps; running: string[]; onDone: () => void }) {
  const utils = trpc.useUtils();
  const build = trpc.setup.build.useMutation({ onSuccess: () => utils.setup.state.invalidate() });
  const busy = running.includes(`build:${projectId}`);
  const done = steps.codeatlas?.status === "done" && steps.memory?.status === "done";
  if (!projectId) return <div className="welcome-body"><p>Choose a repository first.</p></div>;
  return (
    <div className="welcome-body">
      <p>Builds the knowledge graph (services, APIs, tables, owners, history) and a local search index. Both stay current on their own as files change.</p>
      <div className="welcome-frame progress-rows">
        {(["codeatlas", "memory"] as const).map(id => (
          <div key={id} className={`progress-row ${steps[id]?.status ?? "pending"}`}>
            <StepMark status={steps[id]?.status} active={busy} />
            <strong>{id === "codeatlas" ? "CodeAtlas" : "Memory"}</strong>
            <span>{steps[id]?.detail || (id === "codeatlas" ? "Not built" : "Not indexed")}</span>
          </div>
        ))}
        {busy ? <div className="progress-track"><motion.span initial={{ x: "-100%" }} animate={{ x: "100%" }} transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut" }} /></div> : null}
      </div>
      <div className="welcome-actions">
        {done ? <MotionButton className="button primary" onClick={onDone}>Continue <ArrowRight size={14} /></MotionButton> : <MotionButton className="button primary" disabled={busy || build.isPending} onClick={() => build.mutate({ projectId })}>{busy ? "Building…" : steps.codeatlas?.status === "failed" ? "Try again" : "Build"}</MotionButton>}
      </div>
      <ErrorNote error={build.error} />
    </div>
  );
}

function McpStep({ projectId, onDone, onSkip }: { projectId: number | null; onDone: () => void; onSkip: () => void }) {
  const utils = trpc.useUtils();
  const found = trpc.setup.mcp.useQuery({ projectId });
  const add = trpc.setup.importMcp.useMutation({ onSuccess: () => { void found.refetch(); void utils.settings.invalidate(); } });
  const servers = found.data?.servers ?? [];
  return (
    <div className="welcome-body">
      <p>Servers declared in this project's <code>.mcp.json</code>, <code>.cursor/mcp.json</code> or <code>.vscode/mcp.json</code>. Connecting copies the command only; secret values are never copied.</p>
      {found.data ? <div className="policy-strip">{Object.entries(found.data.policy).map(([risk, rule]) => <span key={risk}><b>{risk}</b>{rule}</span>)}</div> : null}
      {servers.length ? (
        <div className="provider-scan">
          {servers.map(server => (
            <div key={server.name} className={`provider-scan-row ${server.imported ? "ok" : ""}`}>
              <span className="provider-scan-name">{server.service ?? server.name}<em>{server.transport}</em></span>
              <span className="provider-scan-reason">{server.source}{server.missingSecrets.length ? ` · set ${server.missingSecrets.join(", ")} yourself` : ""}</span>
              {server.imported ? <span className="status-tag passed"><CheckCircle2 size={10} />Connected</span> : <MotionButton className="button secondary" disabled={add.isPending || server.transport !== "stdio"} onClick={() => add.mutate({ projectId, name: server.name })}><Plug size={13} /> {server.transport === "stdio" ? "Connect" : "HTTP not supported"}</MotionButton>}
            </div>
          ))}
        </div>
      ) : <p className="welcome-note">{found.isLoading ? "Looking…" : "No MCP configs in this project. You can add servers later in Runtime settings."}</p>}
      <div className="welcome-actions">
        <MotionButton className="button primary" onClick={servers.length ? onDone : onSkip}>Continue <ArrowRight size={14} /></MotionButton>
      </div>
      <ErrorNote error={add.error ?? found.error} />
    </div>
  );
}

function VerifyStep({ projectId, steps, running, onDone }: { projectId: number | null; steps: Steps; running: string[]; onDone: () => void }) {
  const utils = trpc.useUtils();
  const busy = running.includes(`baseline:${projectId}`);
  const baseline = trpc.setup.baseline.useQuery({ projectId: projectId ?? 0 }, { enabled: Boolean(projectId) && !busy });
  const run = trpc.setup.runBaseline.useMutation({ onSuccess: () => utils.setup.state.invalidate() });
  useEffect(() => {
    if (!busy) void baseline.refetch();
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!projectId) return <div className="welcome-body"><p>Choose a repository first.</p></div>;
  return (
    <div className="welcome-body">
      <p>Runs the detected typecheck, lint, test and build commands once with a minimal environment. Checks that pass now are enforced after every phase, so agents can't quietly break them.</p>
      <div className="welcome-frame progress-rows">
        {baseline.data?.results.map(result => (
          <div key={result.cmd} className={`progress-row ${result.passed ? "done" : "failed"}`}>
            <StepMark status={result.passed ? "done" : "failed"} active={false} />
            <strong>{result.kind}</strong>
            <span><code>{result.cmd}</code> · {(result.durationMs / 1000).toFixed(1)}s</span>
          </div>
        ))}
        {busy ? <div className="progress-row running"><Loader2 size={13} className="spin-slow" /><strong>Running</strong><span>{steps.verify?.detail}</span></div> : null}
        {!busy && !baseline.data ? <div className="progress-row"><CircleDot size={13} /><strong>Not run</strong><span>{steps.verify?.status === "skipped" ? steps.verify.detail : "Run once to set the baseline"}</span></div> : null}
      </div>
      <div className="welcome-actions">
        <MotionButton className="button primary" disabled={busy || run.isPending} onClick={() => run.mutate({ projectId })}>{busy ? "Running…" : baseline.data ? "Run again" : "Run checks"}</MotionButton>
        {baseline.data || steps.verify?.status === "skipped" ? <MotionButton className="button secondary" onClick={onDone}>Continue <ArrowRight size={14} /></MotionButton> : null}
      </div>
      <ErrorNote error={run.error} />
    </div>
  );
}

function PlanStep({ projectId, onFinish }: { projectId: number | null; onFinish: (path: string) => void }) {
  const utils = trpc.useUtils();
  const analysis = trpc.setup.analysis.useQuery({ projectId: projectId ?? 0 }, { enabled: Boolean(projectId) });
  const complete = trpc.setup.complete.useMutation();
  const generate = trpc.setup.initialPlan.useMutation({
    onSuccess: async () => {
      await complete.mutateAsync();
      void utils.setup.state.invalidate();
      void utils.overview.invalidate();
      void utils.project.invalidate();
      onFinish("/plans");
    },
  });
  if (!projectId) return <div className="welcome-body"><p>Choose a repository first.</p><div className="welcome-actions"><MotionButton className="button secondary" onClick={() => complete.mutate(undefined, { onSuccess: () => onFinish("/request") })}>Start from a request instead</MotionButton></div></div>;
  const data = analysis.data;
  return (
    <div className="welcome-body">
      <p>From the graph and the baseline: what's risky, what's untested and what's marked as debt. The draft plan goes to you for review; nothing runs until you approve it.</p>
      {data ? (
        <>
          <div className="metrics-grid welcome-metrics">
            {([["Services", data.counts.services], ["APIs", data.counts.apis], ["Tables", data.counts.tables], ["Files", data.counts.files], ["Functions", data.counts.functions], ["Test files", data.counts.tests]] as const).map(([label, value]) => <div className="metric-tile" key={label}><span>{label}</span><strong>{value}</strong></div>)}
          </div>
          {data.risks.length ? <ul className="analysis-list">{data.risks.slice(0, 6).map(risk => <li key={risk}>{risk}</li>)}</ul> : <p className="welcome-note">No obvious risks found in the graph.</p>}
          {data.hotspots.length ? <p className="welcome-note">Hotspots: {data.hotspots.slice(0, 4).map(spot => spot.path ?? spot.name).join(", ")}</p> : null}
        </>
      ) : <p><Loader2 size={13} className="spin-slow" /> Analysing…</p>}
      <div className="welcome-actions">
        <MotionButton className="button primary" disabled={generate.isPending || !data} onClick={() => generate.mutate({ projectId })}>{generate.isPending ? "Drafting…" : "Generate initial plan"} <ArrowRight size={14} /></MotionButton>
        <MotionButton className="button secondary" onClick={() => complete.mutate(undefined, { onSuccess: () => onFinish("/") })}>Finish without a plan</MotionButton>
      </div>
      <ErrorNote error={generate.error ?? analysis.error} />
    </div>
  );
}
