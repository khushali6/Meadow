import { AnimatePresence } from "motion/react";
import { ArrowRight, CheckCircle2, CircleDot, Loader2, Plug, SkipForward, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { motion, MotionButton } from "../components/animation/motion";
import { ErrorNote } from "../components/common";
import { TelegramConnect, type Patch } from "../components/settingsParts";
import { trpc } from "../lib/trpc";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import type { Overview, Settings } from "../lib/types";

const STEPS = [
  { id: "repository", label: "Repository", title: "Point Meadow at your code." },
  { id: "engine", label: "Coding engine", title: "Connect the agent that writes the code." },
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

export function WelcomeView({ settings, overview, onNavigate, onProject }: { settings: Settings | undefined; overview: Overview | undefined; onNavigate: (path: string) => void; onProject: (id: number) => void }) {
  const utils = trpc.useUtils();
  const state = trpc.setup.state.useQuery(undefined, { refetchInterval: query => (query.state.data?.running.length ? 1000 : false) });
  const [stepId, setStepId] = useState<StepId | null>(null);
  const steps = state.data?.steps ?? {};
  const projectId = state.data?.projectId ?? null;
  useEffect(() => {
    if (projectId) onProject(projectId);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
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
              {step.id === "repository" ? <RepositoryStep suggested={state.data.suggestedPath} projectId={projectId} steps={steps} running={state.data.running} onDone={next} /> : null}
              {step.id === "engine" ? <EngineStep stepStatus={steps.engine?.status} onDone={next} /> : null}
              {step.id === "llm" ? <ProviderStep stepStatus={steps.llm?.status} onDone={next} onSkip={() => skip("llm")} /> : null}
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

type Steps = Partial<Record<string, { status: string; detail: string }>>;
type SetupOut = inferRouterOutputs<AppRouter>["setup"];
type ProviderRow = SetupOut["providers"]["providers"][number];
type Health = SetupOut["useProvider"];
type EngineRow = SetupOut["engines"]["engines"][number];

function engineTag(engine: EngineRow): { cls: string; text: string } {
  if (engine.status !== "available") return { cls: "queued", text: "Coming soon" };
  if (engine.job?.status === "running") return { cls: "running", text: engine.job.kind === "login" ? "Signing in" : "Installing" };
  if (engine.ready) return { cls: "passed", text: "Ready" };
  if (engine.installed) return { cls: "paused", text: engine.signedIn ? "Needs attention" : "Not signed in" };
  return { cls: "queued", text: "Not installed" };
}

function EngineKeyField({ engine, onSaved }: { engine: EngineRow; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [open, setOpen] = useState(false);
  const save = trpc.setup.saveEngineKey.useMutation({ onSuccess: () => { setKey(""); setOpen(false); onSaved(); } });
  if (!engine.key) return null;
  if (!open) return <span className="welcome-note">{engine.keySet ? <><CheckCircle2 size={12} /> {engine.key} saved · </> : null}<button type="button" className="link-button" onClick={() => setOpen(true)}>{engine.keySet ? "Replace key" : `Use an API key instead (${engine.keyHelp})`}</button></span>;
  return (
    <form className="key-field" onSubmit={event => { event.preventDefault(); if (key.trim()) save.mutate({ engine: engine.name as "cursor", key }); }}>
      <input className="text-input" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={engine.keyHint} aria-label={`${engine.label} API key`} />
      <MotionButton className="button secondary" disabled={key.trim().length < 8 || save.isPending}>{save.isPending ? "Saving…" : "Save key"}</MotionButton>
      <button type="button" className="link-button" onClick={() => setOpen(false)}>Cancel</button>
      <ErrorNote error={save.error} />
    </form>
  );
}

function EngineStep({ stepStatus, onDone }: { stepStatus: string | undefined; onDone: () => void }) {
  const utils = trpc.useUtils();
  const scan = trpc.setup.engines.useQuery(undefined, { refetchOnWindowFocus: true, refetchInterval: query => (query.state.data?.engines.some(engine => engine.job?.status === "running") ? 1500 : false) });
  const [choice, setChoice] = useState<string | null>(null);
  const select = trpc.setup.selectEngine.useMutation({ onSuccess: () => { void utils.setup.state.invalidate(); void utils.overview.invalidate(); void utils.settings.invalidate(); void scan.refetch(); } });
  const connect = trpc.setup.connectEngine.useMutation({ onSuccess: () => void scan.refetch() });
  const install = trpc.setup.installEngine.useMutation({ onSuccess: () => void scan.refetch() });
  const cancel = trpc.setup.cancelEngineJob.useMutation({ onSuccess: () => void scan.refetch() });
  const engines = scan.data?.engines ?? [];
  const chosen = engines.find(engine => engine.name === (choice ?? scan.data?.recommended)) ?? null;
  const [watching, setWatching] = useState<string | null>(null);
  // Once a sign-in the user started succeeds, use that engine without another click.
  useEffect(() => {
    if (!watching) return;
    const engine = engines.find(item => item.name === watching);
    if (engine?.job?.status === "running") return;
    setWatching(null);
    if (engine?.ready) select.mutate({ engine: engine.name as "cursor" });
  }, [scan.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (scan.isLoading) return <div className="welcome-body"><p><Loader2 size={13} className="spin-slow" /> Looking for coding agents on this computer…</p></div>;
  const busy = connect.isPending || install.isPending || select.isPending;
  const inUse = scan.data?.selected;
  const id = (engine: EngineRow) => engine.name as "cursor";
  return (
    <div className="welcome-body">
      <p>Meadow plans and verifies; a coding agent CLI writes the code, on its own branch, inside the project folder. Pick the one you want. Meadow checks what's installed and signed in on this computer, and connects it for you: Connect opens the vendor's sign-in page in your browser.</p>
      {scan.data?.editors.length ? <p className="welcome-note">Found on this computer: {scan.data.editors.join(", ")}.</p> : null}
      <div className="provider-scan">
        {engines.map(engine => {
          const tag = engineTag(engine);
          const isChosen = chosen?.name === engine.name;
          const job = engine.job;
          return (
            <div key={engine.name} className={`provider-block ${engine.ready ? "ok" : ""} ${isChosen ? "recommended" : ""}`}>
              <div className="provider-scan-row">
                <label className="provider-scan-name engine-pick">
                  <input type="radio" name="engine" checked={isChosen} disabled={engine.status !== "available"} onChange={() => setChoice(engine.name)} />
                  {engine.label}<em>{engine.version ?? (engine.app ? "app found" : engine.status === "available" ? "cli" : "soon")}</em>
                </label>
                <span className="provider-scan-reason" title={engine.binary ?? undefined}>{engine.detail}{engine.app && engine.installed ? " · desktop app found" : ""}</span>
                <span className={`status-tag ${tag.cls}`}><span />{tag.text}</span>
              </div>
              {isChosen && engine.status === "available" ? (
                <div className="provider-detail">
                  {job?.status === "running" ? (
                    <span className="welcome-note">
                      <Loader2 size={12} className="spin-slow" /> {job.detail}{" "}
                      {job.url ? <a href={job.url} target="_blank" rel="noreferrer noopener">Open the sign-in page</a> : null}{" "}
                      <button type="button" className="link-button" onClick={() => cancel.mutate({ engine: id(engine) })}>Cancel</button>
                    </span>
                  ) : null}
                  {job && job.status !== "running" ? <span className={job.status === "failed" ? "inline-error" : "welcome-note"}>{job.status === "done" ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {job.detail}</span> : null}
                  {!engine.installed && job?.status !== "running" && engine.install ? (
                    <>
                      <span className="welcome-note">Installs with the vendor's command: <code>{engine.install.command}</code>{engine.install.missing ? ` · ${engine.install.missing}; install it first` : ""}</span>
                      <MotionButton className="button primary" disabled={busy || Boolean(engine.install.missing)} onClick={() => install.mutate({ engine: id(engine) })}>{install.isPending ? "Starting…" : `Install ${engine.label}`}</MotionButton>
                    </>
                  ) : null}
                  {engine.installed && !engine.signedIn && engine.canLogin && job?.status !== "running" ? (
                    <MotionButton className="button primary" disabled={busy} onClick={() => { setWatching(engine.name); connect.mutate({ engine: id(engine) }); }}><Plug size={13} /> {connect.isPending ? "Opening…" : `Connect ${engine.label}`}</MotionButton>
                  ) : null}
                  {engine.installed && !engine.signedIn && !engine.canLogin ? <span className="welcome-note">{engine.label} signs in from its own terminal app; paste an API key below instead.</span> : null}
                  {engine.ready ? (
                    <MotionButton className="button primary" disabled={busy} onClick={() => select.mutate({ engine: id(engine) }, { onSuccess: data => { if (data.ready) onDone(); } })}>{inUse === engine.name && stepStatus === "done" ? "In use · Continue" : `Use ${engine.label}`} <ArrowRight size={14} /></MotionButton>
                  ) : null}
                  {engine.installed && !engine.ready ? <EngineKeyField engine={engine} onSaved={() => void scan.refetch()} /> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="welcome-actions">
        {stepStatus === "done" ? <MotionButton className="button primary" onClick={onDone}>Continue <ArrowRight size={14} /></MotionButton> : null}
        <MotionButton className="button secondary" onClick={() => scan.refetch()} disabled={scan.isFetching}>{scan.isFetching ? "Scanning…" : "Scan again"}</MotionButton>
      </div>
      <ErrorNote error={connect.error ?? install.error ?? select.error ?? cancel.error ?? scan.error} />
    </div>
  );
}

function RepositoryStep({ suggested, projectId, steps, running, onDone }: { suggested: string | null; projectId: number | null; steps: Steps; running: string[]; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState(suggested ?? "");
  const [query, setQuery] = useState(suggested ?? "");
  const locate = trpc.setup.locate.useQuery({ query }, { enabled: query.trim().length > 0, retry: false, refetchOnWindowFocus: false });
  const registered = () => {
    void utils.setup.state.invalidate();
    void utils.overview.invalidate();
    onDone();
  };
  const register = trpc.setup.register.useMutation({ onSuccess: registered });
  const create = trpc.setup.create.useMutation({ onSuccess: registered });
  const clone = trpc.setup.clone.useMutation({ onSuccess: () => utils.setup.state.invalidate() });
  const cloning = running.includes("clone");
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (cloning) setWatching(true);
    else if (watching) {
      setWatching(false);
      if (steps.repository?.status === "done") registered();
    }
  }, [cloning]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = locate.data;
  const busy = register.isPending || create.isPending || clone.isPending || cloning;
  return (
    <div className="welcome-body">
      <p>Type the repository's name, and Meadow finds it in your code folders. A full path, <code>owner/repo</code> or a git URL works too; Meadow clones it to the right place for this computer. <code>.env</code> files and keys are never read.</p>
      <form className="search-row" onSubmit={event => { event.preventDefault(); setQuery(value.trim()); }}>
        <input className="text-input" value={value} onChange={event => setValue(event.target.value)} placeholder="my-app · ~/code/my-app · owner/repo" aria-label="Repository name, path or URL" spellCheck={false} />
        <MotionButton className="button secondary" disabled={!value.trim() || locate.isFetching}>{locate.isFetching ? "Searching…" : "Find"}</MotionButton>
      </form>
      <ErrorNote error={locate.error} />
      {locate.isFetching ? <p className="welcome-note"><Loader2 size={13} className="spin-slow" /> Looking through your code folders…</p> : null}
      {data && !locate.isFetching ? (
        <div className="provider-scan repo-results">
          {data.matches.map((match, i) => (
            <div key={match.path} className={`provider-scan-row repo-row ${i === 0 && match.exact ? "recommended" : ""}`}>
              <span className="provider-scan-name">{match.name}<em>{match.registered ? "added" : match.git ? match.branch ?? "git" : "folder"}</em></span>
              <span className="provider-scan-reason" title={match.path}>{match.path}<br />{match.lines.filter(line => !/^Git repository/.test(line)).slice(0, 5).join(" · ")}</span>
              <MotionButton className={`button ${i === 0 ? "primary" : "secondary"}`} disabled={busy} onClick={() => register.mutate({ path: match.path })}>{register.isPending && register.variables?.path === match.path ? "Adding…" : "Use"} <ArrowRight size={14} /></MotionButton>
            </div>
          ))}
          {data.clone ? (
            <div className="provider-scan-row repo-row recommended">
              <span className="provider-scan-name">Clone {data.clone.slug}<em>{data.clone.via}</em></span>
              <span className="provider-scan-reason" title={data.clone.target}>{data.clone.url}<br />into {data.clone.target}{data.clone.exists ? " (folder exists)" : ""}</span>
              <MotionButton className="button primary" disabled={busy} onClick={() => clone.mutate({ url: data.clone!.url, target: data.clone!.target })}>{cloning ? "Cloning…" : data.clone.exists ? "Use folder" : "Clone"}</MotionButton>
            </div>
          ) : null}
          {data.create && !data.matches.some(match => match.exact) ? (
            <div className="provider-scan-row repo-row">
              <span className="provider-scan-name">New project<em>empty</em></span>
              <span className="provider-scan-reason" title={data.create.target}>{data.matches.length ? `None of these? ` : `No repository called “${query}” on this computer. `}Create {data.create.target}</span>
              <MotionButton className="button secondary" disabled={busy || data.create.exists} onClick={() => create.mutate({ target: data.create!.target })}>{create.isPending ? "Creating…" : data.create.exists ? "Exists" : "Create"}</MotionButton>
            </div>
          ) : null}
        </div>
      ) : null}
      {data && !locate.isFetching ? <p className="welcome-note">{data.kind === "path" ? "Using the path you typed." : `Searched ${data.searched} folders. New and cloned repositories go in ${data.placeDir} (${data.placeReason}).`}</p> : null}
      {cloning ? <p className="welcome-note"><Loader2 size={13} className="spin-slow" /> {steps.repository?.detail || "Cloning…"}</p> : null}
      {steps.repository?.status === "failed" && !cloning ? <p className="inline-error">{steps.repository.detail}</p> : null}
      <div className="welcome-actions">
        {projectId ? <MotionButton className="button secondary" onClick={onDone}>Keep current project</MotionButton> : null}
      </div>
      <ErrorNote error={register.error ?? create.error ?? clone.error} />
    </div>
  );
}

function KeyField({ provider, onSaved }: { provider: ProviderRow; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(!provider.keySet);
  const save = trpc.setup.saveKey.useMutation({ onSuccess: () => { setKey(""); setEditing(false); onSaved(); } });
  if (!editing) return <span className="key-saved"><CheckCircle2 size={12} /> Key saved <button className="link-button" onClick={() => setEditing(true)}>Replace</button></span>;
  return (
    <form className="key-field" onSubmit={event => { event.preventDefault(); if (key.trim()) save.mutate({ provider: provider.id, key }); }}>
      <input className="text-input" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={provider.keyHint} aria-label={`${provider.name} API key`} />
      <MotionButton className="button secondary" disabled={key.trim().length < 8 || save.isPending}>{save.isPending ? "Saving…" : "Save key"}</MotionButton>
      {provider.keySet ? <button type="button" className="link-button" onClick={() => setEditing(false)}>Cancel</button> : null}
      <ErrorNote error={save.error} />
    </form>
  );
}

function HealthSteps({ health }: { health: Health }) {
  return (
    <ul className="detect-lines health-lines">
      {health.steps.map(step => <li key={step.name} className={step.ok ? (step.skipped ? "muted" : "") : "bad"}>{step.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} <b>{step.name}</b> {step.detail}</li>)}
    </ul>
  );
}

function ProviderStep({ stepStatus, onDone, onSkip }: { stepStatus: string | undefined; onDone: () => void; onSkip: () => void }) {
  const utils = trpc.useUtils();
  const scan = trpc.setup.providers.useQuery(undefined, { refetchOnWindowFocus: false });
  const [models, setModels] = useState<Record<string, string>>({});
  const [embed, setEmbed] = useState<Record<string, boolean>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [auto, setAuto] = useState(false);
  const use = trpc.setup.useProvider.useMutation({ onSuccess: data => { setHealth(data); void utils.setup.state.invalidate(); void utils.llm.providers.invalidate(); } });
  const rank = (provider: ProviderRow) => (provider.id === scan.data?.recommended ? 0 : provider.available ? 1 : provider.needsKey && provider.type === "local" ? 2 : provider.type === "cloud" ? 3 : 4);
  const providers = [...(scan.data?.providers ?? [])].sort((a, b) => rank(a) - rank(b));
  const modelFor = (provider: ProviderRow) => models[provider.id] ?? provider.recommendedModel ?? provider.currentModel;
  const run = (provider: ProviderRow) => use.mutate({ provider: provider.id, model: provider.type === "cloud" && !models[provider.id] ? null : modelFor(provider), embeddingModel: provider.embeddingModel && (embed[provider.id] ?? true) ? provider.embeddingModel : null });
  // A detected local server is set up without a click: Meadow picks the model, then runs the real connection test.
  useEffect(() => {
    if (auto || !scan.data || stepStatus === "done" || use.isPending) return;
    const pick = providers.find(provider => provider.id === scan.data!.recommended && provider.type === "local" && provider.recommendedModel);
    setAuto(true);
    if (pick) run(pick);
  }, [scan.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (scan.isLoading) return <div className="welcome-body"><p><Loader2 size={13} className="spin-slow" /> Looking for keys and local model servers…</p></div>;
  return (
    <div className="welcome-body">
      <p>Used for planning, questions and summaries. Local servers are found and configured automatically: Meadow picks the best model your machine can run and tests it with a real request. For a gateway or cloud provider, paste its key below. Keys are stored only in <code>~/.meadow/secrets.env</code>.</p>
      <div className="provider-scan">
        {providers.map(provider => {
          const chat = provider.choices.filter(choice => choice.kind === "chat");
          const mine = health?.provider === provider.id;
          return (
            <div key={provider.id} className={`provider-block ${provider.available ? "ok" : ""} ${provider.id === scan.data?.recommended ? "recommended" : ""}`}>
              <div className="provider-scan-row">
                <span className="provider-scan-name">{provider.name}<em>{provider.type}</em></span>
                <span className="provider-scan-reason">{provider.reason}</span>
                {provider.available ? <MotionButton className={`button ${provider.id === scan.data?.recommended ? "primary" : "secondary"}`} disabled={use.isPending} onClick={() => run(provider)}>{use.isPending && use.variables?.provider === provider.id ? "Testing…" : provider.active && ((mine && health?.ok) || stepStatus === "done") ? "In use · Test again" : "Use and test"}</MotionButton> : <span className="status-tag queued"><span />{provider.needsKey ? "Key needed" : "Not running"}</span>}
              </div>
              {chat.length ? (
                <div className="provider-detail">
                  <label className="prompt-label">Chat model
                    <select value={modelFor(provider)} onChange={event => setModels({ ...models, [provider.id]: event.target.value })}>
                      {chat.map(choice => <option key={choice.id} value={choice.id} disabled={!choice.fits}>{choice.id}{choice.paramsB ? ` · ${choice.paramsB}B` : ""}{choice.id === provider.recommendedModel ? " · recommended" : ""}{choice.fits ? "" : " · too large"}</option>)}
                    </select>
                  </label>
                  {provider.embeddingModel ? <label className="check-label"><input type="checkbox" checked={embed[provider.id] ?? true} onChange={event => setEmbed({ ...embed, [provider.id]: event.target.checked })} /> Use {provider.embeddingModel} for memory search</label> : null}
                  {provider.pickReason ? <span className="welcome-note">{provider.pickReason}</span> : null}
                </div>
              ) : null}
              {provider.secret && (provider.keyRequired || provider.type !== "local") ? <div className="provider-detail"><KeyField provider={provider} onSaved={() => void scan.refetch()} /></div> : null}
              {mine && health ? <div className="provider-detail"><HealthSteps health={health} /></div> : null}
            </div>
          );
        })}
      </div>
      {scan.data?.note ? <p className="welcome-note">{scan.data.note}</p> : null}
      <div className="welcome-actions">
        {health?.ok || stepStatus === "done" ? <MotionButton className="button primary" onClick={onDone}>Continue <ArrowRight size={14} /></MotionButton> : null}
        <MotionButton className="button secondary" onClick={() => scan.refetch()} disabled={scan.isFetching}>{scan.isFetching ? "Scanning…" : "Scan again"}</MotionButton>
        {!health?.ok && stepStatus !== "done" ? <MotionButton className="button secondary" onClick={onSkip}>Continue without a model</MotionButton> : null}
      </div>
      <ErrorNote error={use.error ?? scan.error} />
    </div>
  );
}



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
  const installing = running.includes(`install:${projectId}`);
  const plan = trpc.setup.installPlan.useQuery({ projectId: projectId ?? 0 }, { enabled: Boolean(projectId) && !installing });
  const install = trpc.setup.install.useMutation({ onSuccess: () => utils.setup.state.invalidate() });
  useEffect(() => {
    if (!busy) void baseline.refetch();
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!installing) void plan.refetch();
  }, [installing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!projectId) return <div className="welcome-body"><p>Choose a repository first.</p></div>;
  const lastRun = new Map((plan.data?.last?.results ?? []).map(result => [`${result.dir}|${result.label}`, result]));
  return (
    <div className="welcome-body">
      {plan.data?.steps.length ? (
        <>
          <p>Install dependencies first, with the tools this project uses on this computer (Python gets its own <code>.venv</code>). This runs the project's install scripts, so only do it for code you trust.</p>
          <div className="welcome-frame progress-rows install-rows">
            {plan.data.steps.map(step => {
              const result = lastRun.get(`${step.dir}|${step.label}`);
              const status = step.missing ? "skipped" : result ? (result.ok ? "done" : "failed") : "pending";
              return (
                <div key={`${step.dir}|${step.command}`} className={`progress-row ${status}`} title={result && !result.ok ? result.output : undefined}>
                  <StepMark status={status} active={false} />
                  <strong>{step.label}</strong>
                  <span><code>{step.command}</code>{step.missing ? ` · ${step.missing}` : result ? ` · ${(result.durationMs / 1000).toFixed(1)}s${result.ok ? "" : ` · ${result.output.split("\n").filter(Boolean).pop() ?? "failed"}`}` : ""}</span>
                </div>
              );
            })}
            {installing ? <div className="progress-row running"><Loader2 size={13} className="spin-slow" /><strong>Installing</strong><span>{steps.verify?.detail}</span></div> : null}
          </div>
          <div className="welcome-actions">
            <MotionButton className="button secondary" disabled={installing || install.isPending || plan.data.steps.every(step => step.missing)} onClick={() => install.mutate({ projectId })}>{installing ? "Installing…" : plan.data.last ? "Install again" : "Install dependencies"}</MotionButton>
          </div>
          <ErrorNote error={install.error} />
        </>
      ) : null}
      <p>Runs the detected typecheck, lint, test and build commands once with a minimal environment. Checks that pass now are enforced after every phase, so agents can't quietly break them.</p>
      <div className="welcome-frame progress-rows">
        {baseline.data?.results.map(result => {
          const status = result.passed ? "done" : result.missingTool ? "skipped" : "failed";
          return (
            <div key={result.cmd} className={`progress-row ${status}`} title={result.passed ? undefined : result.output}>
              <StepMark status={status} active={false} />
              <strong>{result.kind}</strong>
              <span><code>{result.cmd}</code> · {result.missingTool ? "tool not installed, skipped" : `${(result.durationMs / 1000).toFixed(1)}s${result.passed ? "" : " · failing now, not enforced"}`}</span>
            </div>
          );
        })}
        {busy ? <div className="progress-row running"><Loader2 size={13} className="spin-slow" /><strong>Running</strong><span>{steps.verify?.detail}</span></div> : null}
        {!busy && !baseline.data ? <div className="progress-row"><CircleDot size={13} /><strong>Not run</strong><span>{steps.verify?.status === "skipped" ? steps.verify.detail : "Run once to set the baseline"}</span></div> : null}
      </div>
      <div className="welcome-actions">
        <MotionButton className="button primary" disabled={busy || installing || run.isPending} onClick={() => run.mutate({ projectId })}>{busy ? "Running…" : baseline.data ? "Run again" : "Run checks"}</MotionButton>
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
