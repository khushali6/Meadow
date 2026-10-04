import { CheckCircle2, Download, Loader2, Plug, Stethoscope, Wrench, XCircle } from "lucide-react";
import { useState } from "react";
import { ErrorNote, PageHeader, Toggle } from "../components/common";
import { HEALTH_LABELS, NumberInput, Row, Section, SecretField, TelegramConnect, type Patch, type SecretName } from "../components/settingsParts";
import { downloadJson } from "../lib/api";
import { trpc } from "../lib/trpc";
import type { Overview, ProjectSummary, Settings } from "../lib/types";
import { MotionButton } from "../components/animation/motion";

type ProviderId = NonNullable<NonNullable<Patch["llm"]>["provider"]>;
const CAPABILITY_LABELS = [["chat", "Chat"], ["jsonMode", "JSON mode"], ["streaming", "Streaming"], ["embeddings", "Embeddings"], ["transcription", "Voice"]] as const;

function AgentModelSection({ patch }: { patch: (value: Patch) => void }) {
  const utils = trpc.useUtils();
  const data = trpc.llm.providers.useQuery(undefined, { refetchOnWindowFocus: false });
  const [viewing, setViewing] = useState<ProviderId | null>(null);
  const active = data.data?.routing.chat.id as ProviderId | undefined;
  const selectedId = viewing ?? active;
  const selected = data.data?.providers.find(provider => provider.id === selectedId);
  const models = trpc.llm.models.useQuery({ provider: selectedId ?? "freellmapi" }, { enabled: Boolean(selected?.configured), refetchOnWindowFocus: false, retry: false });
  const test = trpc.llm.test.useMutation();
  const save = (value: Patch) => { patch(value); setTimeout(() => { utils.llm.providers.invalidate(); utils.llmStatus.invalidate(); }, 150); };
  if (!data.data || !selected) return <Section title="Agent model" description="Loading providers…"><Loader2 size={14} className="spin-slow" /></Section>;
  const { routing, memory, custom, transcriptionProvider, providers } = data.data;
  const providerPatch = (field: "baseUrl" | "model" | "embeddingModel" | "transcriptionModel", value: string) => {
    if (selected.id === "freellmapi") save({ llm: { [field]: value } });
    else save({ llm: { providers: { [selected.id]: { [field]: value } } } });
  };
  const localEmbedders = providers.filter(provider => provider.type !== "cloud" && provider.capabilities.embeddings && !(provider.id === "custom" && custom.allowRemote));
  const voiceProviders = providers.filter(provider => provider.capabilities.transcription);
  const step = test.data && test.variables?.provider === selected.id ? test.data : null;

  return (
    <Section title="Agent model" description="Planning, clarifying questions, summaries and CodeAtlas answers. Pick any provider; memory (index, notes, graph, embeddings) always stays on this machine. Cloud providers only see the prompt text and the snippets Meadow selects.">
      <Row label="Active provider" hint={routing.chat.configured ? `${routing.chat.name} · ${routing.chat.model}` : `${routing.chat.name} is not configured yet.`}>
        <select value={active} onChange={event => { setViewing(null); save({ llm: { provider: event.target.value as ProviderId } }); }} aria-label="Active provider">
          {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}{provider.type === "cloud" ? " (cloud)" : provider.type === "local" ? " (local)" : ""}{provider.configured ? "" : " — needs setup"}</option>)}
        </select>
      </Row>
      <div className="provider-tabs" role="tablist" aria-label="Configure provider">
        {providers.map(provider => (
          <button key={provider.id} role="tab" aria-selected={provider.id === selected.id} className={`provider-tab ${provider.id === selected.id ? "active" : ""} ${provider.configured ? "ready" : ""}`} onClick={() => setViewing(provider.id as ProviderId)}>
            <span className="provider-dot" />{provider.name}{provider.id === active ? <em>active</em> : null}
          </button>
        ))}
      </div>
      <div className="capability-row" aria-label={`${selected.name} capabilities`}>
        <span className="capability-kind">{selected.type}</span>
        {CAPABILITY_LABELS.map(([key, label]) => <span key={key} className={`capability ${selected.capabilities[key] ? "yes" : "no"}`}>{selected.capabilities[key] ? <CheckCircle2 size={10} /> : <XCircle size={10} />}{label}</span>)}
      </div>
      <Row label="Endpoint" hint={selected.baseUrlEditable ? (selected.type === "local" ? "Must be a localhost address." : custom.allowRemote ? "Remote endpoints allowed for this provider." : "Localhost unless you allow remote below.") : "Official endpoint, HTTPS only."}>
        {selected.baseUrlEditable ? <input key={`${selected.id}-url`} className="text-input" defaultValue={selected.baseUrl} onBlur={event => event.target.value.trim() && event.target.value.trim() !== selected.baseUrl && providerPatch("baseUrl", event.target.value.trim())} /> : <code className="inline-code">{selected.baseUrl}</code>}
      </Row>
      <Row label="Chat model" hint={models.data?.error ? `Couldn't list models: ${models.data.error}` : models.data?.models.length ? `${models.data.models.length} models available` : `Default: ${selected.defaults.model}`}>
        <input key={`${selected.id}-model`} className="text-input" list={`models-${selected.id}`} defaultValue={selected.model} onBlur={event => event.target.value.trim() && event.target.value.trim() !== selected.model && providerPatch("model", event.target.value.trim())} />
        <datalist id={`models-${selected.id}`}>{models.data?.models.map(model => <option key={model} value={model} />)}</datalist>
      </Row>
      {selected.capabilities.embeddings ? <Row label="Embedding model"><input key={`${selected.id}-emb`} className="text-input" defaultValue={selected.embeddingModel ?? ""} onBlur={event => event.target.value.trim() !== (selected.embeddingModel ?? "") && providerPatch("embeddingModel", event.target.value.trim())} /></Row> : null}
      {selected.capabilities.transcription ? <Row label="Transcription model"><input key={`${selected.id}-stt`} className="text-input" defaultValue={selected.transcriptionModel ?? ""} onBlur={event => event.target.value.trim() !== (selected.transcriptionModel ?? "") && providerPatch("transcriptionModel", event.target.value.trim())} /></Row> : null}
      {selected.id === "custom" ? (
        <>
          <Row label="Allow remote endpoint" hint="Off keeps the custom endpoint on localhost. Remote endpoints can't compute memory embeddings."><Toggle checked={custom.allowRemote} onChange={value => save({ llm: { custom: { allowRemote: value } } })} label="Allow remote endpoint" /></Row>
          <Row label="Supports embeddings"><Toggle checked={custom.embeddings} onChange={value => save({ llm: { custom: { embeddings: value } } })} label="Supports embeddings" /></Row>
          <Row label="Supports transcription"><Toggle checked={custom.transcription} onChange={value => save({ llm: { custom: { transcription: value } } })} label="Supports transcription" /></Row>
          <Row label="Supports JSON mode"><Toggle checked={custom.jsonMode} onChange={value => save({ llm: { custom: { jsonMode: value } } })} label="Supports JSON mode" /></Row>
        </>
      ) : null}
      {selected.secret ? <SecretField key={selected.secret} name={selected.secret as SecretName} present={selected.keySet} label={`${selected.name} API key${selected.keyRequired ? "" : " (optional)"}`} placeholder={selected.keyHint ?? "Paste your API key"} /> : null}
      <Row label="Test connection" hint="Checks credentials, endpoint, model, a tiny chat, embeddings and voice support.">
        <MotionButton className="button secondary" onClick={() => test.mutate({ provider: selected.id as ProviderId })} disabled={test.isPending}>{test.isPending ? <Loader2 size={14} className="spin-slow" /> : <Stethoscope size={14} />} {test.isPending ? "Testing…" : `Test ${selected.name}`}</MotionButton>
      </Row>
      <ErrorNote error={test.error} />
      {step ? (
        <div className="doctor-list">
          {step.steps.map(item => (
            <div className={`doctor-row ${item.ok ? "ok" : item.skipped ? "optional" : "bad"}`} key={item.name}>
              {item.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              <div><strong>{item.name}</strong><span>{item.detail}</span></div>
            </div>
          ))}
          <div className="doctor-foot">{step.ok ? "Ready" : "Not ready"} · {step.ms} ms</div>
        </div>
      ) : null}
      <Row label="Memory embeddings" hint={routing.embeddings.mode === "blocked" ? routing.embeddings.reason : `Now: ${routing.embeddings.name}. Local hashing needs no model and never leaves this machine.`}>
        <select value={memory.embeddings === "local" ? "local" : memory.embeddingProvider ?? "auto"} onChange={event => {
          const value = event.target.value;
          if (value === "local") save({ memory: { embeddings: "local", embeddingProvider: null } });
          else save({ memory: { embeddings: "provider", embeddingProvider: value as ProviderId } });
        }} aria-label="Memory embeddings">
          <option value="local">Local, built in (recommended)</option>
          {localEmbedders.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.configured}>{provider.name}{provider.configured ? "" : " — needs setup"}</option>)}
        </select>
      </Row>
      <Row label="Voice transcription" hint={routing.voice.available ? `Now: ${routing.voice.name}` : routing.voice.reason}>
        <select value={transcriptionProvider} onChange={event => save({ llm: { transcriptionProvider: event.target.value as ProviderId | "auto" | "off" } })} aria-label="Voice transcription">
          <option value="auto">Automatic</option>
          {voiceProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}{provider.type === "cloud" ? " (audio leaves this machine)" : ""}</option>)}
          <option value="off">Off</option>
        </select>
      </Row>
    </Section>
  );
}

function McpSection({ project }: { project: ProjectSummary | undefined }) {
  const utils = trpc.useUtils();
  const found = trpc.setup.mcp.useQuery({ projectId: project?.id ?? null }, { refetchOnWindowFocus: false });
  const [inspect, setInspect] = useState<string | null>(null);
  const caps = trpc.setup.mcpCapabilities.useQuery({ name: inspect ?? "" }, { enabled: Boolean(inspect), retry: false });
  const done = () => { void found.refetch(); void utils.settings.invalidate(); void utils.setup.health.invalidate(); };
  const add = trpc.setup.importMcp.useMutation({ onSuccess: done });
  const remove = trpc.setup.removeMcp.useMutation({ onSuccess: done });
  return (
    <Section title="MCP servers" description={`Servers found in ${project ? `${project.name}'s` : "this project's"} editor configs. Read tools run automatically, write tools wait for your approval, destructive tools always do and are never offered to MCP clients.`}>
      {found.data ? <div className="policy-strip">{Object.entries(found.data.policy).map(([risk, rule]) => <span key={risk}><b>{risk}</b>{rule}</span>)}</div> : null}
      {(found.data?.servers ?? []).map(server => (
        <Row key={server.name} label={server.service ? `${server.service} (${server.name})` : server.name} hint={`${server.source} · ${server.transport}${server.missingSecrets.length ? ` · needs ${server.missingSecrets.join(", ")} in its own environment` : ""}`}>
          {server.imported ? (
            <>
              <MotionButton className="button secondary" onClick={() => setInspect(inspect === server.name ? null : server.name)}>Tools</MotionButton>
              <MotionButton className="button secondary" onClick={() => remove.mutate({ name: server.name })} disabled={remove.isPending}>Remove</MotionButton>
            </>
          ) : <MotionButton className="button secondary" onClick={() => add.mutate({ projectId: project?.id ?? null, name: server.name })} disabled={add.isPending || server.transport !== "stdio"}><Plug size={13} /> {server.transport === "stdio" ? "Connect" : "HTTP not supported"}</MotionButton>}
        </Row>
      ))}
      {found.data && !found.data.servers.length ? <Row label="None found" hint="Add .mcp.json, .cursor/mcp.json or .vscode/mcp.json to the project, or edit atlas.mcpServers in ~/.meadow/config.json."><span /></Row> : null}
      {inspect ? (
        <div className="doctor-list">
          {caps.isLoading ? <div className="doctor-row optional"><Loader2 size={14} className="spin-slow" /><div><strong>Starting {inspect}…</strong></div></div> : null}
          {caps.data?.error ? <div className="doctor-row bad"><XCircle size={14} /><div><strong>{inspect}</strong><span>{caps.data.error}</span></div></div> : null}
          {caps.data?.tools.map(tool => (
            <div className={`doctor-row ${tool.risk === "READ" ? "ok" : tool.risk === "DESTRUCTIVE" ? "bad" : "optional"}`} key={tool.tool}>
              <span className={`risk-chip ${tool.risk.toLowerCase()}`}>{tool.risk}</span>
              <div><strong>{tool.tool}</strong><span>{tool.description.slice(0, 160)}</span></div>
            </div>
          ))}
        </div>
      ) : null}
      <ErrorNote error={add.error ?? remove.error ?? found.error} />
    </Section>
  );
}

function ConnectedServices({ project, config, patch }: { project: ProjectSummary | undefined; config: Settings["config"]; patch: (value: Patch) => void }) {
  const services = trpc.services.useQuery({ projectId: project?.id ?? null }, { refetchOnWindowFocus: false });
  const login = trpc.serviceLogin.useMutation({ onSuccess: () => setTimeout(() => void services.refetch(), 5000) });
  return (
    <Section title="Connected services" description="What the coding engine can use for you. Meadow picks your accounts on its own, creates only free or private resources, and asks on Telegram before anything that costs money or deletes data.">
      {(services.data ?? []).map(service => (
        <Row key={service.name} label={service.name} hint={`${service.detail}${service.fix && service.status !== "needs_login" ? ` ${service.fix}` : ""}`}>
          {service.status === "needs_login" && service.kind === "mcp"
            ? <MotionButton className="button secondary" onClick={() => login.mutate({ name: service.name })} disabled={login.isPending}><Plug size={13} /> Sign in</MotionButton>
            : <span className={`status-tag ${service.status === "ready" ? "passed" : "queued"}`}><span />{service.status.replace(/_/g, " ")}</span>}
        </Row>
      ))}
      {services.isLoading ? <Row label="Checking services…"><Loader2 size={14} className="spin-slow" /></Row> : null}
      {login.data ? <Row label="Sign-in" hint={login.data.detail}><span /></Row> : null}
      {config.services.supabase.orgName ? <Row label="Supabase organisation" hint="Chosen once; used for every new project.">
        <MotionButton className="button secondary" onClick={() => patch({ services: { supabase: { orgId: null, orgName: null } } })}>{config.services.supabase.orgName} · Forget</MotionButton>
      </Row> : null}
      <Row label="Create a private GitHub repository" hint="For new projects without a remote, using your saved GitHub token. Never public, never for projects that already have a remote."><Toggle checked={config.services.github.createRepo} onChange={value => patch({ services: { github: { createRepo: value } } })} label="Create GitHub repo" /></Row>
      <Row label="Push passed phases" hint="Only to repositories Meadow created; never a force push."><Toggle checked={config.services.github.push} onChange={value => patch({ services: { github: { push: value } } })} label="Push to GitHub" /></Row>
      <ErrorNote error={services.error ?? login.error} />
    </Section>
  );
}

function SelfHealing() {
  const utils = trpc.useUtils();
  const health = trpc.setup.health.useQuery(undefined, { refetchOnWindowFocus: false });
  const repair = trpc.setup.repair.useMutation({ onSuccess: result => utils.setup.health.setData(undefined, result.after) });
  return (
    <>
      <Row label="Self-check" hint="Runs every two minutes in the background and repairs what it can: reconnects Telegram and MCP servers, re-embeds stale memory.">
        <MotionButton className="button secondary" onClick={() => repair.mutate()} disabled={repair.isPending}><Wrench size={14} /> {repair.isPending ? "Repairing…" : "Diagnose and repair"}</MotionButton>
      </Row>
      {health.data ? (
        <div className="doctor-list">
          {health.data.map(check => (
            <div className={`doctor-row ${check.ok ? "ok" : check.skipped ? "optional" : "bad"}`} key={check.area}>
              {check.ok || check.skipped ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              <div><strong>{HEALTH_LABELS[check.area] ?? check.area}</strong><span>{check.detail}</span>{!check.ok && !check.skipped && check.fix ? <code>{check.fix}</code> : null}</div>
            </div>
          ))}
          {repair.data?.repairs.map(item => <div className={`doctor-row ${item.ok ? "ok" : "bad"}`} key={`r-${item.area}`}><Wrench size={14} /><div><strong>Repaired: {HEALTH_LABELS[item.area] ?? item.area}</strong><span>{item.detail}</span></div></div>)}
        </div>
      ) : null}
      <ErrorNote error={repair.error ?? health.error} />
    </>
  );
}

type SupervisorConfig = Settings["config"]["harness"]["supervisor"];
type SupervisorProvider = SupervisorConfig["chain"][number];

const SUPERVISOR_OPTIONS: Array<{ id: SupervisorProvider; label: string; placeholder: string; hint: string }> = [
  { id: "ollama", label: "Ollama", placeholder: "qwen2.5-coder:7b", hint: "Free and private. Uses the closest Qwen coder model you've pulled." },
  { id: "freellmapi", label: "FreeLLMAPI", placeholder: "auto", hint: "Your local FreeLLMAPI gateway; 'auto' lets it route." },
  { id: "anthropic", label: "Claude (Anthropic)", placeholder: "claude-sonnet-4-5", hint: "Paid cloud API, billed to your Anthropic key." },
];

function SkillsSection({ skills: config, patch }: { skills: Settings["config"]["harness"]["skills"]; patch: (value: Patch) => void }) {
  const utils = trpc.useUtils();
  const list = trpc.skills.useQuery(undefined, { refetchOnWindowFocus: false });
  const [source, setSource] = useState("");
  const add = trpc.addSkill.useMutation({ onSuccess: () => { setSource(""); utils.skills.invalidate(); } });
  const remove = trpc.removeSkill.useMutation({ onSuccess: () => utils.skills.invalidate() });
  const disabled = new Set(config.disabled);
  return (
    <Section title="Skills" description="Instructions the coding engine follows on every project, like your UI and animation standards. UI skills apply to screens; others apply everywhere.">
      <Row label="Use skills" hint={`Active skills are copied into each project's .meadow/skills/ and named in every phase prompt. Stored in ${list.data?.home ?? "~/.meadow/skills"}.`}><Toggle checked={config.enabled} onChange={value => patch({ harness: { skills: { enabled: value } } })} label="Use skills" /></Row>
      {(list.data?.skills ?? []).map(skill => (
        <Row key={skill.name} label={`${skill.name} · ${skill.scope === "ui" ? "UI work" : "every phase"}`} hint={skill.description || `${Math.round(skill.bytes / 1000)} KB`}>
          <Toggle checked={!disabled.has(skill.name)} onChange={value => patch({ harness: { skills: { disabled: value ? config.disabled.filter(name => name !== skill.name) : [...config.disabled, skill.name] } } })} label={`Use the ${skill.name} skill`} />
          <MotionButton className="button secondary" onClick={() => remove.mutate({ name: skill.name })}>Remove</MotionButton>
        </Row>
      ))}
      <Row label="Add a skill" hint="Path to a SKILL.md, or a folder containing one (for example a Cursor skill). Meadow keeps its own copy.">
        <input className="text-input" value={source} placeholder="~/path/to/skill/SKILL.md" aria-label="Skill path" onChange={event => setSource(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && source.trim()) add.mutate({ path: source.trim() }); }} />
        <MotionButton className="button" disabled={!source.trim() || add.isPending} onClick={() => add.mutate({ path: source.trim() })}>{add.isPending ? "Adding…" : "Add"}</MotionButton>
      </Row>
      <ErrorNote error={add.error ?? remove.error} />
    </Section>
  );
}

function SupervisorChain({ supervisor, patch }: { supervisor: SupervisorConfig; patch: (value: Patch) => void }) {
  const status = trpc.teamStatus.useQuery(undefined, { refetchOnWindowFocus: false });
  const chain = supervisor.chain;
  const members = status.data?.supervisor.chain ?? [];
  const setChain = (next: SupervisorProvider[]) => patch({ harness: { supervisor: { chain: next } } });
  return (
    <>
      <Row label="Order" hint="Tried top to bottom; a provider that is down or has no key is skipped. Your agent model is always the last resort.">
        <span className="team-chain">{chain.length ? chain.map(id => SUPERVISOR_OPTIONS.find(option => option.id === id)?.label ?? id).join(" → ") : "Agent model only"}{status.data?.supervisor.active ? <em> · now: {status.data.supervisor.active.name} {status.data.supervisor.active.model}</em> : null}</span>
      </Row>
      {SUPERVISOR_OPTIONS.map(option => {
        const on = chain.includes(option.id);
        const member = members.find(item => item.provider === option.id);
        const state = !on ? "Off" : !member ? "…" : member.needsKey ? "Needs key" : !member.reachable ? "Not reachable" : !member.hasModel ? "Model not pulled" : "Ready";
        return (
          <div key={option.id} className="supervisor-provider">
            <Row label={`${option.label} · ${state}`} hint={option.hint}>
              <Toggle checked={on} onChange={value => setChain(value ? [...chain, option.id] : chain.filter(id => id !== option.id))} label={`Use ${option.label} as supervisor`} />
              <input key={supervisor.models[option.id] ?? ""} className="text-input" placeholder={option.placeholder} defaultValue={supervisor.models[option.id] ?? ""} aria-label={`${option.label} supervisor model`} onBlur={event => { const model = event.target.value.trim(); if (model !== (supervisor.models[option.id] ?? "")) patch({ harness: { supervisor: { models: { [option.id]: model } } } }); }} />
              {on && chain[0] !== option.id ? <MotionButton className="button secondary" onClick={() => setChain([option.id, ...chain.filter(id => id !== option.id)])}>Make first</MotionButton> : null}
            </Row>
            {on && member?.needsKey ? <SecretField name={member.needsKey as SecretName} present={false} label={`${option.label} API key`} placeholder={option.id === "anthropic" ? "sk-ant-… from console.anthropic.com" : "The unified key from the FreeLLMAPI Keys page"} /> : null}
          </div>
        );
      })}
    </>
  );
}

export function SettingsView({ settings, overview, project, onNavigate }: { settings: Settings | undefined; overview: Overview | undefined; project: ProjectSummary | undefined; onNavigate: (path: string) => void }) {
  const utils = trpc.useUtils();
  const update = trpc.updateSettings.useMutation({ onSuccess: data => utils.settings.setData(undefined, data) });
  const updateProject = trpc.updateProject.useMutation({ onSuccess: () => { utils.overview.invalidate(); utils.project.invalidate(); } });
  const doctor = trpc.doctor.useQuery(undefined, { enabled: false });
  const exportRun = trpc.exportRun.useMutation({ onSuccess: data => downloadJson(`${data.project.name}-run-export.json`, data) });
  if (!settings) return <div className="event-empty">Loading settings…</div>;
  const { config, secrets } = settings;
  const patch = (value: Patch) => update.mutate(value);
  const tg = overview?.telegram;
  const activeEngine = project?.engine ?? config.engine.default;
  const engineLabel = (name: string) => settings.engines.find(engine => engine.name === name)?.label ?? name;

  return (
    <>
      <PageHeader eyebrow="06 / RUNTIME SETTINGS" title="Tune the guardrails." description="Meadow runs on this computer. The only outbound traffic is to your coding engine, the agent model provider you pick, Telegram if you connect it, and connectors you switch on." />
      <ErrorNote error={update.error ?? updateProject.error ?? exportRun.error} />
      <div className="settings-grid">

      <AgentModelSection patch={patch} />

      <Section title="Coding engine" description="The tool that actually edits code. Meadow drives it phase by phase and verifies every result.">
        <Row label="Default engine"><select value={config.engine.default} onChange={event => patch({ engine: { default: event.target.value as typeof config.engine.default } })}>{settings.engines.map(engine => <option key={engine.name} value={engine.name} disabled={engine.status !== "available"}>{engine.label}{engine.status === "coming_soon" ? " — coming soon" : ""}</option>)}</select></Row>
        {project ? <Row label={`Engine for ${project.name}`}><select value={project.engine} onChange={event => updateProject.mutate({ id: project.id, engine: event.target.value })}>{settings.engines.map(engine => <option key={engine.name} value={engine.name} disabled={engine.status !== "available"}>{engine.label}{engine.status === "coming_soon" ? " — coming soon" : ""}</option>)}</select></Row> : null}
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
        {settings.engines.filter(engine => engine.status === "coming_soon").map(engine => <Row key={engine.name} label={engine.label} hint="The adapter is built but not enabled yet."><span className="status-tag queued"><span />Coming soon</span></Row>)}
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

      <Section title="Agent team" description="Specialist agents (backend, UI, QA) work in your coding engine; a supervisor model reads their failures and reports to you on Telegram.">
        <Row label="Supervisor" hint="After a failed attempt the supervisor diagnoses the cause, gives the fix agent concrete instructions, and stops early when only you can unblock it. It gets the failing check output with secrets and .env values removed."><Toggle checked={config.harness.supervisor.enabled} onChange={value => patch({ harness: { supervisor: { enabled: value } } })} label="Supervisor" /></Row>
        {config.harness.supervisor.enabled ? <SupervisorChain supervisor={config.harness.supervisor} patch={patch} /> : null}
        <Row label="Parallel agents" hint="Phases the plan marks with the same parallel_group run at the same time, each in its own git worktree, then merge into main. A conflicting agent merges main into its branch and resolves the conflict itself."><Toggle checked={config.harness.parallel.enabled} onChange={value => patch({ harness: { parallel: { enabled: value } } })} label="Parallel agents" /></Row>
        <Row label="Agents at once"><NumberInput value={config.harness.parallel.maxAgents} min={1} onCommit={value => patch({ harness: { parallel: { maxAgents: Math.min(8, value) } } })} /></Row>
      </Section>

      <SkillsSection skills={config.harness.skills} patch={patch} />

      <Section title="Automation" description="What Meadow does on its own. Plans, writes and destructive actions still wait for your approval.">
        <Row label="Keep graph and memory live" hint="Watches git every 20 s; changed files are re-indexed and the graph is rebuilt in one transaction."><Toggle checked={config.atlas.liveUpdate} onChange={value => patch({ atlas: { liveUpdate: value } })} label="Live graph" /></Row>
        <Row label="Impact analysis before each phase" hint="Adds the affected services, APIs, tables and owners to the engine's context."><Toggle checked={config.harness.preflightImpact} onChange={value => patch({ harness: { preflightImpact: value } })} label="Preflight impact" /></Row>
        <Row label="Enforce detected checks" hint="Checks that passed at baseline (typecheck, lint, test, build) run after every phase."><Toggle checked={config.harness.autoVerify} onChange={value => patch({ harness: { autoVerify: value } })} label="Auto verify" /></Row>
        <Row label="End-to-end tests in a browser" hint="After the last phase, Meadow runs the app like you would, clicks through every main flow in a headless browser and sends errors back to the engine. Screenshots go out only when every case passes."><Toggle checked={config.harness.e2e} onChange={value => patch({ harness: { e2e: value } })} label="End-to-end tests" /></Row>
        <Row label="Premium design standard" hint="Web projects get a design brief in every phase (typography, palette, spacing, states, motion, mobile), and the browser tests send pages that still look like browser defaults back to the engine. Put your own brief in ~/.meadow/design.md or .meadow/design.md in a project."><Toggle checked={config.harness.design} onChange={value => patch({ harness: { design: value } })} label="Design standard" /></Row>
        <Row label="Planner" hint="'Engine' uses the Cursor CLI in read-only mode to write SPEC.md and PLAN.md — same top-tier model that codes. 'Local LLM' uses the chat provider above (faster but weaker). The plan is still auto-improved and must be approved before anything is built."><select value={config.llm.plannerEngine ?? "engine"} onChange={event => patch({ llm: { plannerEngine: event.target.value as "engine" | "llm" } })}><option value="engine">Engine (Cursor) — recommended</option><option value="llm">Local LLM</option></select></Row>
        <Row label="Run the engine in its sandbox" hint="Limits the coding engine to the project folder when its CLI supports a sandbox. Meadow's command deny-list and after-run checks apply either way. Turn off only if package installs fail inside the sandbox."><Toggle checked={config.guard.sandbox === "auto"} onChange={value => patch({ guard: { sandbox: value ? "auto" : "off" } })} label="Engine sandbox" /></Row>
        <Row label="Let the engine ask you" hint="The engine can ask you questions and request system installs, Docker or cloud resources through Meadow; you answer on Telegram or here."><Toggle checked={config.guard.broker} onChange={value => patch({ guard: { broker: value } })} label="Engine broker" /></Row>
        <Row label="Resume interrupted runs on restart" hint="Continues from the last verified phase after a crash or reboot. Off: you resume by hand."><Toggle checked={config.harness.autoResume} onChange={value => patch({ harness: { autoResume: value } })} label="Auto resume" /></Row>
        <Row label="Check for signed updates" hint="Only manifests signed by the Meadow publisher key are trusted."><Toggle checked={config.updates.check} onChange={value => patch({ updates: { check: value } })} label="Update checks" /></Row>
        <Row label="Guided setup" hint="Detect a repository, build its knowledge, run checks and draft a first plan."><MotionButton className="button secondary" onClick={() => onNavigate("/welcome")}>Open setup</MotionButton></Row>
      </Section>

      <ConnectedServices project={project} config={config} patch={patch} />

      <Section title="Budgets" description={`Today: ${(overview?.usage.tokens ?? 0).toLocaleString()} tokens across ${overview?.usage.runs ?? 0} engine runs.`}>
        <Row label="Tokens per phase"><NumberInput value={config.budget.phaseTokens} min={1000} step={1000} onCommit={value => patch({ budget: { phaseTokens: value } })} /></Row>
        <Row label="Tokens per day"><NumberInput value={config.budget.dailyTokens} min={1000} step={1000} onCommit={value => patch({ budget: { dailyTokens: value } })} /></Row>
        <Row label="Wall clock per phase"><NumberInput value={config.budget.phaseWallClockS} min={60} suffix="s" onCommit={value => patch({ budget: { phaseWallClockS: value } })} /></Row>
      </Section>

      <Section title="Telegram" description="Send requests by text or voice and get phase updates with screenshots. Only your paired account gets answers; everyone else gets silence.">
        <TelegramConnect tg={tg} config={config} hasOwnToken={secrets.telegram} patch={patch} />
        <Row label="Notifications"><select value={config.telegram.notificationLevel} onChange={event => patch({ telegram: { notificationLevel: event.target.value as "all" | "phases" | "failures" } })}><option value="all">Everything, with a live progress card</option><option value="phases">Phase starts and results</option><option value="failures">Only problems</option></select></Row>
        <Row label="Quiet hours" hint="Non-urgent updates are held until the window ends.">
          <Toggle checked={config.telegram.quietHours.enabled} onChange={value => patch({ telegram: { quietHours: { ...config.telegram.quietHours, enabled: value } } })} label="Quiet hours" />
          <NumberInput value={config.telegram.quietHours.start} min={0} suffix=":00 to" onCommit={value => patch({ telegram: { quietHours: { ...config.telegram.quietHours, start: Math.min(23, Math.max(0, Math.round(value))) } } })} />
          <NumberInput value={config.telegram.quietHours.end} min={0} suffix=":00" onCommit={value => patch({ telegram: { quietHours: { ...config.telegram.quietHours, end: Math.min(23, Math.max(0, Math.round(value))) } } })} />
        </Row>
        <Row label="Voice replies" hint="Needs piper and ffmpeg installed."><Toggle checked={config.telegram.voiceReplies} onChange={value => patch({ telegram: { voiceReplies: value } })} label="Voice replies" /></Row>
      </Section>

      <Section title="CodeAtlas" description="Knowledge graph and investigations. Code, git history, docs and incidents are indexed locally. Issue trackers are contacted only when you switch them on and save a token.">
        <Row label="LLM rerank" hint="Ask the agent model to rerank retrieved evidence. Falls back to fused scores when it is unavailable."><Toggle checked={config.atlas.rerank} onChange={value => patch({ atlas: { rerank: value } })} label="LLM rerank" /></Row>
        <Row label="Agent tool steps" hint="Maximum tool calls the operator agent may make per question."><NumberInput value={config.atlas.maxAgentSteps} min={1} onCommit={value => patch({ atlas: { maxAgentSteps: Math.min(20, Math.max(1, Math.round(value))) } })} /></Row>
        <Row label="GitHub issues and PRs" hint="Repo defaults to the git origin remote."><Toggle checked={config.atlas.connectors.github.enabled} onChange={value => patch({ atlas: { connectors: { github: { enabled: value } } } })} label="GitHub connector" /></Row>
        {config.atlas.connectors.github.enabled ? (
          <>
            <Row label="Repository" hint="owner/name"><input className="text-input" placeholder="from origin remote" defaultValue={config.atlas.connectors.github.repo ?? ""} onBlur={event => patch({ atlas: { connectors: { github: { repo: event.target.value.trim() || null } } } })} /></Row>
            <SecretField name="GITHUB_TOKEN" present={secrets.github} label="GitHub token" placeholder="Fine-grained token with read access to issues and PRs" />
          </>
        ) : null}
        <Row label="Jira"><Toggle checked={config.atlas.connectors.jira.enabled} onChange={value => patch({ atlas: { connectors: { jira: { enabled: value } } } })} label="Jira connector" /></Row>
        {config.atlas.connectors.jira.enabled ? (
          <>
            <Row label="Site URL" hint="https://your-team.atlassian.net"><input className="text-input" defaultValue={config.atlas.connectors.jira.baseUrl ?? ""} onBlur={event => patch({ atlas: { connectors: { jira: { baseUrl: event.target.value.trim() || null } } } })} /></Row>
            <Row label="Account email"><input className="text-input" defaultValue={config.atlas.connectors.jira.email ?? ""} onBlur={event => patch({ atlas: { connectors: { jira: { email: event.target.value.trim() || null } } } })} /></Row>
            <Row label="JQL"><input className="text-input" defaultValue={config.atlas.connectors.jira.jql} onBlur={event => event.target.value.trim() && patch({ atlas: { connectors: { jira: { jql: event.target.value.trim() } } } })} /></Row>
            <SecretField name="JIRA_API_TOKEN" present={secrets.jira} label="Jira API token" placeholder="From id.atlassian.com → Security → API tokens" />
          </>
        ) : null}
        <Row label="Linear"><Toggle checked={config.atlas.connectors.linear.enabled} onChange={value => patch({ atlas: { connectors: { linear: { enabled: value } } } })} label="Linear connector" /></Row>
        {config.atlas.connectors.linear.enabled ? (
          <>
            <Row label="Team key" hint="Optional, e.g. ENG"><input className="text-input" defaultValue={config.atlas.connectors.linear.teamKey ?? ""} onBlur={event => patch({ atlas: { connectors: { linear: { teamKey: event.target.value.trim() || null } } } })} /></Row>
            <SecretField name="LINEAR_API_KEY" present={secrets.linear} label="Linear API key" placeholder="lin_api_…" />
          </>
        ) : null}
      </Section>

      <McpSection project={project} />

      <Section title="Watch runs" description="The coding engine works in the background. When a run starts, Meadow can open the project in your editor (files change as the engine edits them) and a terminal following its live output.">
        <Row label="Open the project in the editor"><Toggle checked={config.watch.editor} onChange={value => patch({ watch: { editor: value } })} label="Open the project in the editor" /></Row>
        <Row label="Open a live output terminal"><Toggle checked={config.watch.terminal} onChange={value => patch({ watch: { terminal: value } })} label="Open a live output terminal" /></Row>
      </Section>

      <Section title="Screenshots" description="Captured only from the project's own localhost preview, desktop and mobile, after checks pass.">
        <Row label="Take screenshots"><Toggle checked={config.screenshots.enabled} onChange={value => patch({ screenshots: { enabled: value } })} label="Take screenshots" /></Row>
        {project ? <Row label={`Screenshots for ${project.name}`}><Toggle checked={Boolean(project.screenshots)} onChange={value => updateProject.mutate({ id: project.id, screenshots: value })} label="Project screenshots" /></Row> : null}
      </Section>

      <Section title="Health and data" description="Doctor checks your tools without changing anything. Exports contain plans, checks, runs and events for one project.">
        <SelfHealing />
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
