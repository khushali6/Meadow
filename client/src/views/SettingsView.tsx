import { CheckCircle2, Download, KeyRound, Loader2, MessageCircle, RefreshCw, Stethoscope, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ErrorNote, PageHeader, Toggle } from "../components/common";
import { downloadJson } from "../lib/api";
import { trpc } from "../lib/trpc";
import type { Overview, ProjectSummary, Settings } from "../lib/types";
import { MotionButton } from "../components/animation/motion";

type Patch = Parameters<ReturnType<typeof trpc.updateSettings.useMutation>["mutate"]>[0];

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="panel settings-section">
      <div className="settings-section-head"><div><h2>{title}</h2><p>{description}</p></div></div>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="setting-control"><div><strong>{label}</strong>{hint ? <span>{hint}</span> : null}</div><div className="setting-inline">{children}</div></div>;
}

function NumberInput({ value, onCommit, min, step = 1, suffix }: { value: number; onCommit: (value: number) => void; min?: number; step?: number; suffix?: string }) {
  const [draft, setDraft] = useState(String(value));
  return (
    <span className="number-input">
      <input type="number" value={draft} min={min} step={step} onChange={event => setDraft(event.target.value)} onBlur={() => { const parsed = Number(draft); if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed); else setDraft(String(value)); }} />
      {suffix ? <em>{suffix}</em> : null}
    </span>
  );
}

function SecretField({ name, present, label, placeholder }: { name: "FREELLMAPI_API_KEY" | "TELEGRAM_BOT_TOKEN"; present: boolean; label: string; placeholder: string }) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState("");
  const save = trpc.setSecret.useMutation({ onSuccess: () => { setValue(""); utils.settings.invalidate(); utils.llmStatus.invalidate(); utils.overview.invalidate(); utils.doctor.invalidate(); } });
  return (
    <div className="secret-field">
      <Row label={label} hint={present ? "Stored in ~/.meadow/secrets.env (owner-only file). Never shown again." : "Not set"}>
        <span className={`status-tag ${present ? "passed" : "blocked"}`}>{present ? <CheckCircle2 size={10} /> : <XCircle size={10} />}{present ? "Set" : "Missing"}</span>
      </Row>
      <form className="search-row" onSubmit={event => { event.preventDefault(); save.mutate({ name, value }); }}>
        <input type="password" autoComplete="off" value={value} onChange={event => setValue(event.target.value)} placeholder={placeholder} aria-label={label} />
        <MotionButton className="button secondary" disabled={value.trim().length < 8 || save.isPending}><KeyRound size={14} /> {present ? "Replace" : "Save"}</MotionButton>
      </form>
      <ErrorNote error={save.error} />
    </div>
  );
}

export function SettingsView({ settings, overview, project }: { settings: Settings | undefined; overview: Overview | undefined; project: ProjectSummary | undefined }) {
  const utils = trpc.useUtils();
  const update = trpc.updateSettings.useMutation({ onSuccess: data => utils.settings.setData(undefined, data) });
  const updateProject = trpc.updateProject.useMutation({ onSuccess: () => { utils.overview.invalidate(); utils.project.invalidate(); } });
  const llm = trpc.llmStatus.useQuery(undefined, { refetchOnWindowFocus: false });
  const doctor = trpc.doctor.useQuery(undefined, { enabled: false });
  const pair = trpc.pairTelegram.useMutation();
  const exportRun = trpc.exportRun.useMutation({ onSuccess: data => downloadJson(`${data.project.name}-run-export.json`, data) });
  if (!settings) return <div className="event-empty">Loading settings…</div>;
  const { config, secrets } = settings;
  const patch = (value: Patch) => update.mutate(value);
  const tg = overview?.telegram;
  const activeEngine = project?.engine ?? config.engine.default;
  const engineLabel = (name: string) => settings.engines.find(engine => engine.name === name)?.label ?? name;

  return (
    <>
      <PageHeader eyebrow="06 / RUNTIME SETTINGS" title="Tune the guardrails." description="Meadow runs entirely on this computer. The only outbound traffic is to your coding engine, your local FreeLLMAPI gateway, and Telegram if you connect it." />
      <ErrorNote error={update.error ?? updateProject.error ?? exportRun.error} />
      <div className="settings-grid">

      <Section title="Agent model (FreeLLMAPI)" description="All planning, clarifying questions, summaries, embeddings and voice transcription go through your local FreeLLMAPI gateway.">
        <Row label="Gateway status" hint={llm.data?.detail}>
          {llm.isFetching ? <Loader2 size={14} className="spin-slow" /> : <span className={`status-tag ${llm.data?.ok ? "passed" : "blocked"}`}>{llm.data?.ok ? <CheckCircle2 size={10} /> : <XCircle size={10} />}{llm.data?.ok ? "Connected" : "Not ready"}</span>}
          <button className="icon-button" onClick={() => llm.refetch()} aria-label="Recheck gateway"><RefreshCw size={14} /></button>
        </Row>
        {llm.data && !llm.data.ok && llm.data.fix ? <div className="fix-hint">{llm.data.fix}</div> : null}
        <Row label="Base URL" hint="Must be a localhost address."><input className="text-input" defaultValue={config.llm.baseUrl} onBlur={event => event.target.value !== config.llm.baseUrl && patch({ llm: { baseUrl: event.target.value } })} /></Row>
        <Row label="Model" hint={'"auto" lets FreeLLMAPI pick the best available provider.'}><input className="text-input" defaultValue={config.llm.model} onBlur={event => event.target.value && event.target.value !== config.llm.model && patch({ llm: { model: event.target.value } })} /></Row>
        <SecretField name="FREELLMAPI_API_KEY" present={secrets.freellmapi} label="Unified API key" placeholder="Paste the key from your FreeLLMAPI dashboard" />
      </Section>

      <Section title="Coding engine" description="The tool that actually edits code. Meadow drives it phase by phase and verifies every result.">
        <Row label="Default engine"><select value={config.engine.default} onChange={event => patch({ engine: { default: event.target.value as typeof config.engine.default } })}>{settings.engines.map(engine => <option key={engine.name} value={engine.name}>{engine.label}</option>)}</select></Row>
        {project ? <Row label={`Engine for ${project.name}`}><select value={project.engine} onChange={event => updateProject.mutate({ id: project.id, engine: event.target.value })}>{settings.engines.map(engine => <option key={engine.name} value={engine.name}>{engine.label}</option>)}</select></Row> : null}
        <Row label={`Model for ${engineLabel(activeEngine)}`} hint="Leave empty for the engine's own default. With a local gateway, use a model it serves.">
          <input key={activeEngine} className="text-input" placeholder="engine default" defaultValue={config.engine.models?.[activeEngine as keyof typeof config.engine.models] ?? ""} onBlur={event => {
            const value = event.target.value.trim() || null;
            if (value !== (config.engine.models?.[activeEngine as keyof typeof config.engine.models] ?? null)) patch({ engine: { models: { ...config.engine.models, [activeEngine]: value } } });
          }} />
        </Row>
        {activeEngine === "custom" ? (
          <Row label="Custom command" hint={'Set engine.custom.command in ~/.meadow/config.json. It gets the prompt as $MEADOW_PROMPT and $MEADOW_PROMPT_FILE.'}>
            <code className="inline-code">{config.engine.custom.command || "not set"}</code>
          </Row>
        ) : null}
        <Row label="Route Claude Code through FreeLLMAPI" hint="Claude Code uses your gateway instead of an Anthropic key."><Toggle checked={config.engine.claudeUseFreeLlmApi} onChange={value => patch({ engine: { claudeUseFreeLlmApi: value } })} label="Route Claude Code through FreeLLMAPI" /></Row>
        <Row label="Engine run timeout"><NumberInput value={config.engine.runTimeoutS} min={60} suffix="s" onCommit={value => patch({ engine: { runTimeoutS: value } })} /></Row>
        <Row label="Kill if silent for"><NumberInput value={config.engine.noOutputTimeoutS} min={30} suffix="s" onCommit={value => patch({ engine: { noOutputTimeoutS: value } })} /></Row>
      </Section>

      <Section title="Harness" description="How hard Meadow tries before asking you, and when it pauses.">
        <Row label="Attempts per phase"><NumberInput value={config.harness.maxAttempts} min={1} onCommit={value => patch({ harness: { maxAttempts: value } })} /></Row>
        <Row label="Check timeout"><NumberInput value={config.harness.checkTimeoutS} min={10} suffix="s" onCommit={value => patch({ harness: { checkTimeoutS: value } })} /></Row>
        <Row label="Ask before deleting more than"><NumberInput value={config.harness.massDeleteThreshold} min={1} suffix="files" onCommit={value => patch({ harness: { massDeleteThreshold: value } })} /></Row>
        <Row label="Between phases" hint="Ask waits for your OK after every passed phase."><select value={config.harness.phaseGate} onChange={event => patch({ harness: { phaseGate: event.target.value as "auto" | "ask" } })}><option value="auto">Continue automatically</option><option value="ask">Ask me first</option></select></Row>
        <Row label="Approvals expire after" hint="Expired approvals are always denied."><NumberInput value={config.approvals.expiryS} min={60} suffix="s" onCommit={value => patch({ approvals: { expiryS: value } })} /></Row>
      </Section>

      <Section title="Budgets" description={`Today: ${(overview?.usage.tokens ?? 0).toLocaleString()} tokens across ${overview?.usage.runs ?? 0} engine runs.`}>
        <Row label="Tokens per phase"><NumberInput value={config.budget.phaseTokens} min={1000} step={1000} onCommit={value => patch({ budget: { phaseTokens: value } })} /></Row>
        <Row label="Tokens per day"><NumberInput value={config.budget.dailyTokens} min={1000} step={1000} onCommit={value => patch({ budget: { dailyTokens: value } })} /></Row>
        <Row label="Wall clock per phase"><NumberInput value={config.budget.phaseWallClockS} min={60} suffix="s" onCommit={value => patch({ budget: { phaseWallClockS: value } })} /></Row>
      </Section>

      <Section title="Telegram" description="Send requests by text or voice and get phase updates with screenshots. Only the paired owner gets answers; everyone else gets silence.">
        <Row label="Bot" hint={tg?.lastError ?? (tg?.bot ? `@${tg.bot}` : undefined)}>
          <span className={`status-tag ${tg?.running ? "passed" : "queued"}`}><MessageCircle size={10} />{tg?.running ? (tg.paired ? "Paired" : "Waiting to pair") : tg?.configured ? "Not running" : "Not set up"}</span>
        </Row>
        <SecretField name="TELEGRAM_BOT_TOKEN" present={secrets.telegram} label="Bot token" placeholder="123456:ABC… from @BotFather" />
        {secrets.telegram ? (
          <Row label="Pair your account" hint="Send the code to your bot within 15 minutes.">
            <MotionButton className="button secondary" onClick={() => pair.mutate()} disabled={pair.isPending}>New pairing code</MotionButton>
          </Row>
        ) : null}
        {pair.data ? <div className="pair-code"><span>Send this to {pair.data.bot ? `@${pair.data.bot}` : "your bot"}:</span><code>/pair {pair.data.code}</code></div> : null}
        <Row label="Notifications"><select value={config.telegram.notificationLevel} onChange={event => patch({ telegram: { notificationLevel: event.target.value as "all" | "phases" | "failures" } })}><option value="all">Everything, with a live progress card</option><option value="phases">Phase starts and results</option><option value="failures">Only problems</option></select></Row>
        <Row label="Quiet hours" hint="Non-urgent updates are held until the window ends.">
          <Toggle checked={config.telegram.quietHours.enabled} onChange={value => patch({ telegram: { quietHours: { ...config.telegram.quietHours, enabled: value } } })} label="Quiet hours" />
          <NumberInput value={config.telegram.quietHours.start} min={0} suffix=":00 to" onCommit={value => patch({ telegram: { quietHours: { ...config.telegram.quietHours, start: Math.min(23, Math.max(0, Math.round(value))) } } })} />
          <NumberInput value={config.telegram.quietHours.end} min={0} suffix=":00" onCommit={value => patch({ telegram: { quietHours: { ...config.telegram.quietHours, end: Math.min(23, Math.max(0, Math.round(value))) } } })} />
        </Row>
        <Row label="Voice replies" hint="Needs piper and ffmpeg installed."><Toggle checked={config.telegram.voiceReplies} onChange={value => patch({ telegram: { voiceReplies: value } })} label="Voice replies" /></Row>
      </Section>

      <Section title="Screenshots" description="Captured only from the project's own localhost preview, desktop and mobile, after checks pass.">
        <Row label="Take screenshots"><Toggle checked={config.screenshots.enabled} onChange={value => patch({ screenshots: { enabled: value } })} label="Take screenshots" /></Row>
        {project ? <Row label={`Screenshots for ${project.name}`}><Toggle checked={Boolean(project.screenshots)} onChange={value => updateProject.mutate({ id: project.id, screenshots: value })} label="Project screenshots" /></Row> : null}
      </Section>

      <Section title="Health and data" description="Doctor checks your tools without changing anything. Exports contain plans, checks, runs and events for one project.">
        <Row label="Doctor"><MotionButton className="button secondary" onClick={() => doctor.refetch()} disabled={doctor.isFetching}><Stethoscope size={14} /> {doctor.isFetching ? "Checking…" : "Run doctor"}</MotionButton></Row>
        {doctor.data ? (
          <div className="doctor-list">
            {[...doctor.data.system, ...doctor.data.engines.flatMap(engine => engine.checks.map(check => ({ ...check, name: `${engine.engine}: ${check.name}`, optional: engine.engine !== doctor.data!.defaultEngine })))].map(check => (
              <div className={`doctor-row ${check.ok ? "ok" : check.optional ? "optional" : "bad"}`} key={check.name}>
                {check.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <div><strong>{check.name}</strong><span>{check.detail}</span>{!check.ok && check.fix ? <code>{check.fix}</code> : null}</div>
              </div>
            ))}
          </div>
        ) : null}
        {project ? <Row label={`Export ${project.name}`}><MotionButton className="button secondary" onClick={() => exportRun.mutate({ projectId: project.id })} disabled={exportRun.isPending}><Download size={14} /> Download JSON</MotionButton></Row> : null}
        <Row label="Projects folder" hint="Change with MEADOW_PROJECTS_DIR or ~/.meadow/config.json."><code>{config.projectsDir}</code></Row>
      </Section>
      </div>
    </>
  );
}
