import path from "node:path";
import { z } from "zod";
import { getInvestigation, listInvestigations } from "./meadow/atlas/agents";
import { mcpConfigSnippet } from "./meadow/atlas/mcpServer";
import { closeExternalClients } from "./meadow/atlas/mcpClient";
import { atlasStatus, createDemo, evaluate, nodeDetail, pathBetween, startIngest, startInvestigation, systemMap, toolCatalogue } from "./meadow/atlas/service";
import { indexGithubRepo, listExternalRepos, removeExternalRepo } from "./meadow/atlas/github-index";
import { listActions, runTool } from "./meadow/atlas/tools";
import { publicProcedure, router } from "./_core/trpc";
import { checkRelayUrl } from "./meadow/channels/relay";
import { telegram, createPairingCode } from "./meadow/channels/telegram";
import { getSecret, loadConfig, meadowHome, saveConfig, setSecret } from "./meadow/config";
import { decide, getApproval, listApprovals } from "./meadow/core/approvals";
import { addGrant } from "./meadow/guard/grants";
import { connectedServices, startMcpLogin } from "./meadow/services/registry";
import { auditLog, RISK_POLICY } from "./meadow/core/audit";
import { getDb } from "./meadow/core/db";
import { userPath } from "./meadow/core/paths";
import { cloneRepository, createProjectFolder, locateRepository } from "./meadow/setup/locate";
import { commandLine, installPlan, lastInstall, runInstall } from "./meadow/setup/install";
import { fullDoctor, llmStatus } from "./meadow/doctor";
import { PROVIDERS } from "./meadow/llm/catalog";
import { healthCheck, llmRouting, providerFor, providerSummaries } from "./meadow/llm/router";
import { assertSelectableEngine, engineInfo } from "./meadow/engines/registry";
import { harness } from "./meadow/harness/runner";
import { openWatchWindows } from "./meadow/harness/watch";
import { teamStatus } from "./meadow/harness/orchestrator";
import { overlapsMeadow } from "./meadow/core/self";
import { handleAction, handleText } from "./meadow/intake/conversation";
import { improvePlan } from "./meadow/intake/llm";
import { parsePlan } from "./meadow/planning/format";
import { addNote, approvePlan, createProject, getPlan, getProject, savePlanVersion, updateProject } from "./meadow/projects";
import { changeImpact, nodesForPaths } from "./meadow/atlas/impact";
import { embedDocs } from "./meadow/atlas/ingest";
import { metrics } from "./meadow/metrics";
import { renderBrief } from "./meadow/brief/brief";
import { planNextSteps, projectStatus } from "./meadow/brief/next";
import { bus } from "./meadow/core/events";
import { indexMemory, indexProject, memoryStatus, reembed, search } from "./meadow/rag/index";
import { exportBundle, notesFor, phaseDiff, phaseEvidence, planHistory, projectDetail, projectsOverview, usageToday } from "./meadow/service";
import { captureOnDemand } from "./meadow/visual/ondemand";
import { checkForUpdate } from "./meadow/core/updates";
import { analyzeRepository } from "./meadow/setup/analysis";
import { detectProject, profileLines } from "./meadow/setup/detect";
import { diagnose, diagnoseAndRepair } from "./meadow/setup/health";
import { liveGraph } from "./meadow/setup/live";
import { discoverMcp, EXTERNAL_POLICY, importMcp, mcpCapabilities, removeMcp } from "./meadow/setup/mcp";
import { buildKnowledge, completeOnboarding, generateInitialPlan, markStep, ONBOARDING_STEPS, onboardingState, registerRepository, resetOnboarding } from "./meadow/setup/onboarding";
import { assertEngineReady, cancelEngineJob, connectEngine, installEngine, saveEngineKey, scanEngines, selectEngine } from "./meadow/setup/engines";
import { saveProviderKey, scanProviders, useProvider } from "./meadow/setup/providers";
import { baselineOf, runBaseline } from "./meadow/setup/verify";

const DASHBOARD = { channel: "dashboard", chat: "local" } as const;

const engineId = z.enum(["cursor", "codex", "gemini", "claude_code"]);
const providerId = z.enum(["freellmapi", "openai", "gemini", "anthropic", "openrouter", "ollama", "lmstudio", "custom"]);
const providerSettings = z.object({ baseUrl: z.string().url().max(300), model: z.string().max(200), embeddingModel: z.string().max(200), transcriptionModel: z.string().max(200) }).partial();

const configPatch = z.object({
  engine: z.object({ default: z.enum(["cursor", "claude_code", "codex", "gemini", "custom", "fake"]), model: z.string().nullable(), models: z.record(z.string(), z.string().max(120).nullable()), runTimeoutS: z.number().min(60).max(6 * 3600), noOutputTimeoutS: z.number().min(30).max(3600), claudeUseFreeLlmApi: z.boolean() }).partial().optional(),
  harness: z.object({ maxAttempts: z.number().int().min(1).max(10), checkTimeoutS: z.number().min(10).max(7200), massDeleteThreshold: z.number().int().min(1), phaseGate: z.enum(["auto", "ask"]), autoResume: z.boolean(), autoVerify: z.boolean(), preflightImpact: z.boolean(), e2e: z.boolean(), design: z.boolean(), supervisor: z.object({ enabled: z.boolean(), provider: providerId, model: z.string().min(1).max(120) }).partial(), parallel: z.object({ enabled: z.boolean(), maxAgents: z.number().int().min(1).max(8) }).partial() }).partial().optional(),
  updates: z.object({ check: z.boolean() }).partial().optional(),
  budget: z.object({ phaseTokens: z.number().int().min(1000), dailyTokens: z.number().int().min(1000), phaseWallClockS: z.number().int().min(60) }).partial().optional(),
  telegram: z.object({ mode: z.enum(["hosted", "own"]), relayUrl: z.string().max(300), notificationLevel: z.enum(["all", "phases", "failures"]), quietHours: z.object({ enabled: z.boolean(), start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }), voiceReplies: z.boolean() }).partial().optional(),
  screenshots: z.object({ enabled: z.boolean() }).partial().optional(),
  watch: z.object({ editor: z.boolean(), terminal: z.boolean() }).partial().optional(),
  llm: z.object({
    provider: providerId,
    plannerEngine: z.enum(["engine", "llm"]),
    baseUrl: z.string().url(),
    model: z.string().min(1).max(200),
    embeddingModel: z.string().max(200),
    transcriptionModel: z.string().max(200),
    providers: z.partialRecord(providerId, providerSettings),
    custom: z.object({ label: z.string().max(60), allowRemote: z.boolean(), embeddings: z.boolean(), transcription: z.boolean(), jsonMode: z.boolean() }).partial(),
    transcriptionProvider: z.union([providerId, z.literal("auto"), z.literal("off")]),
  }).partial().optional(),
  memory: z.object({ embeddings: z.enum(["local", "provider"]), embeddingProvider: providerId.nullable() }).partial().optional(),
  approvals: z.object({ expiryS: z.number().int().min(60) }).partial().optional(),
  guard: z.object({ sandbox: z.enum(["auto", "off"]), broker: z.boolean() }).partial().optional(),
  services: z.object({ github: z.object({ createRepo: z.boolean(), push: z.boolean() }).partial(), supabase: z.object({ orgId: z.string().max(100).nullable(), orgName: z.string().max(200).nullable() }).partial() }).partial().optional(),
  atlas: z.object({
    rerank: z.boolean(),
    liveUpdate: z.boolean(),
    maxAgentSteps: z.number().int().min(1).max(20),
    connectors: z.object({
      github: z.object({ enabled: z.boolean(), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).nullable() }).partial(),
      jira: z.object({ enabled: z.boolean(), baseUrl: z.string().url().startsWith("https://").nullable(), email: z.string().email().nullable(), jql: z.string().max(500) }).partial(),
      linear: z.object({ enabled: z.boolean(), teamKey: z.string().max(20).nullable() }).partial(),
    }).partial(),
  }).partial().optional(),
});

const atlasRouter = router({
  status: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => atlasStatus(input.projectId)),
  ingest: publicProcedure.input(z.object({ projectId: z.number() })).mutation(({ input }) => startIngest(input.projectId)),
  map: publicProcedure.input(z.object({ projectId: z.number(), layer: z.enum(["architecture", "apis", "history", "code"]), focus: z.number().nullable().default(null), extra: z.array(z.number()).max(60).default([]) })).query(({ input }) => systemMap(input.projectId, input.layer, input.focus, input.extra)),
  node: publicProcedure.input(z.object({ nodeId: z.number() })).query(({ input }) => nodeDetail(input.nodeId)),
  path: publicProcedure.input(z.object({ from: z.number(), to: z.number() })).query(({ input }) => pathBetween(input.from, input.to)),
  impact: publicProcedure.input(z.object({ projectId: z.number(), nodeId: z.number().optional(), paths: z.array(z.string().max(300)).max(50).optional(), depth: z.number().int().min(1).max(5).default(3) })).query(({ input }) => {
    const seeds = input.nodeId ? [input.nodeId] : nodesForPaths(input.projectId, input.paths ?? []).map(node => node.id);
    return changeImpact(seeds, input.depth);
  }),
  phaseImpact: publicProcedure.input(z.object({ phaseId: z.number() })).query(async ({ input }) => {
    const phase = getDb().get<{ project_id: number }>("SELECT plans.project_id FROM phases JOIN plans ON plans.id = phases.plan_id WHERE phases.id = ?", input.phaseId);
    if (!phase) throw new Error("Phase not found");
    const diff = await phaseDiff(input.phaseId);
    const paths = diff.files.map(file => file.path);
    return { paths, report: changeImpact(nodesForPaths(phase.project_id, paths).map(node => node.id)) };
  }),
  search: publicProcedure.input(z.object({ projectId: z.number(), query: z.string().min(2).max(500), mode: z.enum(["hybrid", "vector", "bm25", "graph", "symbol"]).default("hybrid") })).query(({ input }) => runTool("search_code", { query: input.query, mode: input.mode, k: 12 }, { projectId: input.projectId, actor: "ui" })),
  investigate: publicProcedure.input(z.object({ projectId: z.number(), question: z.string().min(5).max(1000), mode: z.enum(["agentic", "hybrid", "graph", "vector"]).default("agentic") })).mutation(async ({ input }) => ({ id: await startInvestigation(input.projectId, input.question, input.mode) })),
  investigations: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => listInvestigations(input.projectId)),
  investigation: publicProcedure.input(z.object({ id: z.number() })).query(({ input }) => getInvestigation(input.id)),
  runAction: publicProcedure.input(z.object({ projectId: z.number(), investigationId: z.number().nullable(), tool: z.enum(["propose_patch", "create_issue", "run_tests"]), args: z.record(z.string(), z.unknown()) })).mutation(({ input }) => runTool(input.tool, input.args, { projectId: input.projectId, actor: "ui", investigationId: input.investigationId })),
  actions: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => listActions(input.projectId)),
  tools: publicProcedure.query(() => toolCatalogue()),
  evaluate: publicProcedure.input(z.object({ projectId: z.number() })).mutation(({ input }) => evaluate(input.projectId)),
  demo: publicProcedure.mutation(() => createDemo()),
  mcpConfig: publicProcedure.query(() => mcpConfigSnippet(path.resolve(process.argv[1] ?? "dist/cli.js"))),
  // External GitHub repo indexing (business-decision memory).
  indexGithubRepo: publicProcedure
    .input(z.object({ projectId: z.number(), url: z.string().min(5).max(300), force: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      const steps: string[] = [];
      const result = await indexGithubRepo(input.projectId, input.url, {
        force: input.force,
        onProgress: step => steps.push(step),
      });
      return { ...result, steps };
    }),
  listExternalRepos: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => listExternalRepos(input.projectId)),
  removeExternalRepo: publicProcedure
    .input(z.object({ projectId: z.number(), repo: z.string().min(3).max(200) }))
    .mutation(({ input }) => { removeExternalRepo(input.projectId, input.repo); return { removed: input.repo }; }),
});

/** Memory stays local: embeddings may only come from a provider that runs on this machine. Cloud base URLs are fixed. */
function validateLlmPatch(input: z.infer<typeof configPatch>) {
  for (const [id, settings] of Object.entries(input.llm?.providers ?? {})) {
    if (settings?.baseUrl && PROVIDERS[id as keyof typeof PROVIDERS]?.type === "cloud") throw new Error(`${PROVIDERS[id as keyof typeof PROVIDERS].name} always uses its official endpoint.`);
  }
  if (input.memory?.embeddings === "provider" || input.memory?.embeddingProvider) {
    const current = loadConfig();
    const id = input.memory.embeddingProvider ?? current.memory.embeddingProvider ?? input.llm?.provider ?? current.llm.provider;
    const def = PROVIDERS[id];
    const allowRemote = input.llm?.custom?.allowRemote ?? current.llm.custom.allowRemote;
    if (def.type === "cloud" || (def.id === "custom" && allowRemote)) throw new Error(`Memory stays on this machine, so ${def.name} can't compute embeddings. Choose local embeddings, FreeLLMAPI, Ollama or LM Studio.`);
  }
}

function safeSettings() {
  const config = loadConfig();
  return {
    config,
    secrets: { freellmapi: Boolean(getSecret("FREELLMAPI_API_KEY")), telegram: Boolean(getSecret("TELEGRAM_BOT_TOKEN")), github: Boolean(getSecret("GITHUB_TOKEN")), jira: Boolean(getSecret("JIRA_API_TOKEN")), linear: Boolean(getSecret("LINEAR_API_KEY")) },
    engines: engineInfo(),
  };
}

const setupJobs = new Set<string>();
/** Runs a long setup step in the background once; progress is read back through onboarding state. */
function background(key: string, job: () => Promise<void>) {
  if (setupJobs.has(key)) return { started: false };
  setupJobs.add(key);
  void job().finally(() => setupJobs.delete(key));
  return { started: true };
}

const setupRouter = router({
  state: publicProcedure.query(() => {
    const cwd = process.cwd();
    const profile = detectProject(cwd);
    const suggestedPath = (profile.git.repo || profile.markers.length) && !cwd.startsWith(meadowHome()) && !overlapsMeadow(cwd) ? cwd : null;
    return { ...onboardingState(), order: ONBOARDING_STEPS, running: [...setupJobs], suggestedPath };
  }),
  step: publicProcedure.input(z.object({ id: z.enum(ONBOARDING_STEPS), status: z.enum(["pending", "running", "done", "skipped", "failed"]), detail: z.string().max(500).default("") })).mutation(({ input }) => markStep(input.id, input.status, input.detail)),
  complete: publicProcedure.mutation(() => completeOnboarding()),
  reset: publicProcedure.mutation(() => resetOnboarding()),
  detect: publicProcedure.input(z.object({ path: z.string().min(1).max(1000) })).query(({ input }) => {
    const resolved = userPath(input.path);
    if (!resolved) throw new Error("Use the full path to the repository.");
    const profile = detectProject(resolved);
    return { profile, lines: profileLines(profile) };
  }),
  register: publicProcedure.input(z.object({ path: z.string().min(1).max(1000) })).mutation(async ({ input }) => {
    const result = await registerRepository(input.path);
    markStep("repository", "done", `${result.project.name} at ${result.project.path}`, result.project.id);
    return { project: result.project, created: result.created, lines: profileLines(result.profile) };
  }),
  locate: publicProcedure.input(z.object({ query: z.string().trim().min(1).max(500) })).query(({ input }) => locateRepository(input.query)),
  clone: publicProcedure.input(z.object({ url: z.string().min(3).max(500), target: z.string().min(1).max(1000) })).mutation(({ input }) => {
    const target = userPath(input.target);
    if (!target) throw new Error("Use a full path for the clone target.");
    return background("clone", async () => {
      markStep("repository", "running", `Cloning into ${target}`);
      try {
        const dir = await cloneRepository(input.url, target, detail => markStep("repository", "running", detail));
        const result = await registerRepository(dir);
        markStep("repository", "done", `${result.project.name} at ${result.project.path}`, result.project.id);
      } catch (error) {
        markStep("repository", "failed", (error as Error).message);
      }
    });
  }),
  create: publicProcedure.input(z.object({ target: z.string().min(1).max(1000) })).mutation(async ({ input }) => {
    const target = userPath(input.target);
    if (!target) throw new Error("Use a full path for the new project.");
    const result = await registerRepository(createProjectFolder(target));
    markStep("repository", "done", `${result.project.name} at ${result.project.path} (new)`, result.project.id);
    return { project: result.project };
  }),
  engines: publicProcedure.query(() => scanEngines()),
  connectEngine: publicProcedure.input(z.object({ engine: engineId })).mutation(({ input }) => connectEngine(input.engine)),
  installEngine: publicProcedure.input(z.object({ engine: engineId })).mutation(({ input }) => installEngine(input.engine)),
  cancelEngineJob: publicProcedure.input(z.object({ engine: engineId })).mutation(({ input }) => cancelEngineJob(input.engine)),
  saveEngineKey: publicProcedure.input(z.object({ engine: engineId, key: z.string().min(8).max(500) })).mutation(({ input }) => saveEngineKey(input.engine, input.key)),
  selectEngine: publicProcedure.input(z.object({ engine: engineId })).mutation(async ({ input }) => {
    const result = selectEngine(input.engine, onboardingState().projectId);
    const engine = (await scanEngines()).engines.find(item => item.name === input.engine);
    markStep("engine", engine?.ready ? "done" : "failed", engine?.ready ? `${engine.label}${engine.version ? ` ${engine.version}` : ""} · ${engine.detail}` : engine?.detail ?? "Not connected");
    return { ...result, ready: Boolean(engine?.ready) };
  }),
  providers: publicProcedure.query(() => scanProviders()),
  saveKey: publicProcedure.input(z.object({ provider: providerId, key: z.string().min(8).max(500) })).mutation(({ input }) => {
    saveProviderKey(input.provider, input.key);
    return { saved: true };
  }),
  useProvider: publicProcedure.input(z.object({ provider: providerId, model: z.string().max(200).nullish(), embeddingModel: z.string().max(200).nullish() })).mutation(async ({ input }) => {
    const health = await useProvider(input.provider, { model: input.model, embeddingModel: input.embeddingModel });
    markStep("llm", health.ok ? "done" : "failed", health.ok ? `${input.provider} · ${health.model}` : health.steps.find(step => !step.ok)?.detail ?? "Connection test failed");
    return health;
  }),
  installPlan: publicProcedure.input(z.object({ projectId: z.number() })).query(async ({ input }) => ({ steps: (await installPlan(getProject(input.projectId).path)).map(step => ({ ...step, command: commandLine(step) })), last: lastInstall(input.projectId) })),
  install: publicProcedure.input(z.object({ projectId: z.number() })).mutation(({ input }) => background(`install:${input.projectId}`, async () => {
    const before = onboardingState().steps.verify;
    markStep("verify", "running", "Installing dependencies");
    try {
      await runInstall(input.projectId, detail => markStep("verify", "running", detail));
    } finally {
      markStep("verify", before?.status ?? "pending", before?.detail ?? "");
    }
  })),
  build: publicProcedure.input(z.object({ projectId: z.number() })).mutation(({ input }) => background(`build:${input.projectId}`, async () => {
    markStep("codeatlas", "running", "Starting");
    try {
      const { graph, memory } = await buildKnowledge(input.projectId, (step, detail) => {
        if (step === "memory") markStep("memory", "running", detail);
        else markStep("codeatlas", "running", `${step}${detail ? `: ${detail}` : ""}`);
      });
      markStep("codeatlas", "done", `${graph.services} services, ${graph.functions} functions, ${graph.apis} APIs, ${graph.tables} tables in ${(graph.ms / 1000).toFixed(1)}s`);
      markStep("memory", "done", `${memory.files} files, ${memory.chunks} chunks${memory.embedded ? `, embedded with ${memory.embedder}` : ""}`);
    } catch (error) {
      markStep("codeatlas", "failed", (error as Error).message);
    }
  })),
  analysis: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => analyzeRepository(input.projectId)),
  baseline: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => baselineOf(input.projectId) ?? null),
  runBaseline: publicProcedure.input(z.object({ projectId: z.number() })).mutation(({ input }) => background(`baseline:${input.projectId}`, async () => {
    markStep("verify", "running", "Running detected checks");
    try {
      const baseline = await runBaseline(input.projectId, result => markStep("verify", "running", `${result.passed ? "✓" : "✗"} ${result.cmd}`));
      const failed = baseline.results.filter(result => !result.passed).length;
      markStep("verify", baseline.results.length ? "done" : "skipped", baseline.results.length ? `${baseline.results.length - failed} of ${baseline.results.length} checks pass${failed ? `; ${failed} failing will be enforced once fixed` : ""}` : "No test, lint, typecheck or build commands detected");
    } catch (error) {
      markStep("verify", "failed", (error as Error).message);
    }
  })),
  initialPlan: publicProcedure.input(z.object({ projectId: z.number() })).mutation(({ input }) => {
    const result = generateInitialPlan(input.projectId);
    markStep("plan", "done", `Plan v${result.version} ready for review`);
    return result;
  }),
  mcp: publicProcedure.input(z.object({ projectId: z.number().nullable() })).query(({ input }) => ({ servers: discoverMcp(input.projectId ? getProject(input.projectId).path : process.cwd()), policy: EXTERNAL_POLICY })),
  importMcp: publicProcedure.input(z.object({ projectId: z.number().nullable(), name: z.string().min(1).max(80) })).mutation(({ input }) => importMcp(input.projectId ? getProject(input.projectId).path : process.cwd(), input.name)),
  removeMcp: publicProcedure.input(z.object({ name: z.string().min(1).max(80) })).mutation(async ({ input }) => {
    removeMcp(input.name);
    await closeExternalClients();
  }),
  mcpCapabilities: publicProcedure.input(z.object({ name: z.string().min(1).max(80) })).query(({ input }) => mcpCapabilities(input.name)),
  health: publicProcedure.query(() => diagnose()),
  repair: publicProcedure.mutation(() => diagnoseAndRepair()),
  updates: publicProcedure.query(() => (loadConfig().updates.check ? checkForUpdate() : { status: "not_configured" as const, current: "" })),
});

export const appRouter = router({
  overview: publicProcedure.query(() => ({
    projects: projectsOverview(),
    approvals: listApprovals(100),
    telegram: telegram.status(),
    usage: usageToday(),
  })),
  project: publicProcedure.input(z.object({ id: z.number() })).query(({ input }) => projectDetail(input.id)),
  phaseEvidence: publicProcedure.input(z.object({ phaseId: z.number() })).query(({ input }) => phaseEvidence(input.phaseId)),
  phaseDiff: publicProcedure.input(z.object({ phaseId: z.number() })).query(({ input }) => phaseDiff(input.phaseId)),
  teamStatus: publicProcedure.query(() => teamStatus()),

  createProject: publicProcedure.input(z.object({ name: z.string().min(2).max(48), engine: z.string(), description: z.string().max(500).optional() })).mutation(({ input }) => createProject(input)),
  updateProject: publicProcedure.input(z.object({ id: z.number(), engine: z.string().optional(), screenshots: z.boolean().optional(), description: z.string().optional() })).mutation(({ input }) => {
    return updateProject(input.id, { engine: input.engine, description: input.description, screenshots: input.screenshots === undefined ? undefined : input.screenshots ? 1 : 0 });
  }),

  validatePlan: publicProcedure.input(z.object({ markdown: z.string().max(500_000) })).mutation(({ input }) => {
    const result = parsePlan(input.markdown);
    return { ok: result.ok, errors: result.errors, warnings: result.warnings, phases: result.ok ? result.plan.phases.map(phase => ({ id: phase.id, name: phase.name, dependsOn: phase.dependsOn, checks: phase.checks.length })) : [] };
  }),
  savePlan: publicProcedure.input(z.object({ projectId: z.number(), markdown: z.string().max(500_000) })).mutation(({ input }) => savePlanVersion(input.projectId, input.markdown, { source: "user" })),
  approvePlan: publicProcedure.input(z.object({ planId: z.number(), start: z.boolean().default(true) })).mutation(async ({ input }) => {
    if (input.start) await assertEngineReady(getProject(getPlan(input.planId).project_id).engine);
    const plan = await approvePlan(input.planId);
    if (input.start) await harness.start(plan.project_id);
    return plan;
  }),
  improvePlan: publicProcedure.input(z.object({ planId: z.number() })).mutation(async ({ input }) => {
    const plan = getPlan(input.planId);
    return savePlanVersion(plan.project_id, await improvePlan(plan.raw_md), { source: "suggested" });
  }),
  planHistory: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => planHistory(input.projectId)),

  watchProject: publicProcedure.input(z.object({ projectId: z.number() })).mutation(async ({ input }) => {
    const opened = await openWatchWindows(input.projectId, { editor: true, terminal: true });
    if (!opened.editor && !opened.terminal) throw new Error("Couldn't find Cursor, VS Code, Windsurf or a terminal app to open.");
    return opened;
  }),

  control: publicProcedure.input(z.object({ projectId: z.number(), action: z.enum(["start", "pause", "resume", "stop", "retry", "skip", "rollback"]), hint: z.string().max(4000).optional(), engine: z.string().optional() })).mutation(async ({ input }) => {
    switch (input.action) {
      case "start":
      case "resume":
        return { executionId: await harness.start(input.projectId, { engine: input.engine }) };
      case "pause":
        harness.pause(input.projectId);
        return {};
      case "stop":
        await harness.stop(input.projectId);
        return {};
      case "retry":
        return { executionId: await harness.retry(input.projectId, input.hint) };
      case "skip":
        await harness.skipPhase(input.projectId);
        return {};
      case "rollback":
        await harness.rollback(input.projectId);
        return {};
    }
  }),

  decideApproval: publicProcedure.input(z.object({ id: z.number(), decision: z.enum(["approved", "denied"]) })).mutation(({ input }) => decide(input.id, input.decision, "dashboard")),
  answerQuestion: publicProcedure.input(z.object({ id: z.number(), answer: z.string().trim().min(1).max(2000) })).mutation(({ input }) => {
    if (getApproval(input.id)?.kind !== "question") throw new Error("That is not a question from the engine.");
    return decide(input.id, "approved", "dashboard", input.answer);
  }),
  approveAlways: publicProcedure.input(z.object({ id: z.number() })).mutation(({ input }) => {
    const row = getApproval(input.id);
    if (!row || row.status !== "pending" || row.project_id === null || !/^system\./.test(row.kind)) throw new Error("Only pending system actions can be allowed for good.");
    addGrant(row.project_id, row.kind);
    return decide(input.id, "approved", "dashboard");
  }),
  services: publicProcedure.input(z.object({ projectId: z.number().nullable() }).optional()).query(({ input }) => connectedServices(input?.projectId ? getProject(input.projectId).path : undefined)),
  serviceLogin: publicProcedure.input(z.object({ name: z.string().regex(/^[\w.-]{1,60}$/) })).mutation(({ input }) => startMcpLogin(input.name, "dashboard")),

  notes: publicProcedure.input(z.object({ projectId: z.number().nullable() })).query(({ input }) => notesFor(input.projectId)),
  addNote: publicProcedure.input(z.object({ projectId: z.number().nullable(), title: z.string().min(1).max(200), body: z.string().min(1).max(20_000) })).mutation(async ({ input }) => {
    const id = addNote({ ...input, source: "dashboard" });
    if (input.projectId) await indexMemory(input.projectId, input.title, `${input.title}\n${input.body}`);
    return { id };
  }),
  search: publicProcedure.input(z.object({ projectId: z.number(), query: z.string().min(1).max(500) })).query(({ input }) => search(input.projectId, input.query, 10)),
  reindex: publicProcedure.input(z.object({ projectId: z.number() })).mutation(async ({ input }) => {
    const result = await indexProject(input.projectId, getProject(input.projectId).path);
    await liveGraph.markIndexed(input.projectId).catch(() => undefined);
    return result;
  }),
  projectStatus: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => {
    const status = projectStatus(input.projectId);
    return { ...status, briefText: renderBrief(status.brief, 6000), brief: { ...status.brief, spec: "" } };
  }),
  planNext: publicProcedure.input(z.object({ projectId: z.number(), request: z.string().max(2000).optional() })).mutation(async ({ input }) => {
    const result = await planNextSteps(input.projectId, input.request);
    bus.emitEvent({ projectId: input.projectId, type: "plan_ready", title: `Plan v${result.version} drafted with ${result.added.length} new phase${result.added.length === 1 ? "" : "s"}`, detail: result.added.join(", ") });
    return result;
  }),
  audit: publicProcedure.input(z.object({ projectId: z.number().nullable(), limit: z.number().int().min(1).max(500).default(100) })).query(({ input }) => ({ rows: auditLog(input.projectId, input.limit), policy: RISK_POLICY })),
  metrics: publicProcedure.input(z.object({ projectId: z.number().nullable(), days: z.number().int().min(1).max(90).default(14) })).query(({ input }) => metrics(input.projectId, input.days)),
  memoryStatus: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => memoryStatus(input.projectId)),
  reembed: publicProcedure.input(z.object({ projectId: z.number() })).mutation(async ({ input }) => {
    const chunks = await reembed(input.projectId);
    const atlasDocs = await embedDocs(input.projectId);
    bus.emitEvent({ projectId: input.projectId, type: "memory", title: chunks.failed ? "Re-embedding failed: embedding provider unavailable" : `Re-embedded ${chunks.updated} chunks and ${atlasDocs} CodeAtlas documents`, detail: chunks.space ?? "", payload: { space: chunks.space, chunks: chunks.updated, atlasDocs } });
    return { ...chunks, atlasDocs };
  }),
  shot: publicProcedure.input(z.object({ projectId: z.number(), route: z.string().nullable() })).mutation(({ input }) => captureOnDemand(input.projectId, input.route)),

  chat: publicProcedure.input(z.object({ text: z.string().min(1).max(100_000) })).mutation(({ input }) => handleText(DASHBOARD.channel, DASHBOARD.chat, input.text)),
  chatAction: publicProcedure.input(z.object({ action: z.string().max(200) })).mutation(({ input }) => handleAction(DASHBOARD.channel, DASHBOARD.chat, input.action, "dashboard")),

  settings: publicProcedure.query(() => safeSettings()),
  updateSettings: publicProcedure.input(configPatch).mutation(({ input }) => {
    if (input.engine?.default) assertSelectableEngine(input.engine.default);
    validateLlmPatch(input);
    if (input.telegram?.relayUrl) input.telegram.relayUrl = checkRelayUrl(input.telegram.relayUrl);
    const telegramChanged = input.telegram?.mode !== undefined || input.telegram?.relayUrl !== undefined;
    saveConfig(input);
    if (telegramChanged) {
      telegram.stop();
      void telegram.start();
    }
    return safeSettings();
  }),
  setSecret: publicProcedure.input(z.object({ name: z.enum(["FREELLMAPI_API_KEY", "AGENT_OPENAI_API_KEY", "AGENT_GEMINI_API_KEY", "AGENT_ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "LLM_API_KEY", "TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "JIRA_API_TOKEN", "LINEAR_API_KEY"]), value: z.string().min(8).max(500) })).mutation(async ({ input }) => {
    setSecret(input.name, input.value.trim());
    if (input.name === "TELEGRAM_BOT_TOKEN") {
      saveConfig({ telegram: { mode: "own" } });
      telegram.stop();
      await telegram.start();
    }
    return safeSettings();
  }),
  pairTelegram: publicProcedure.mutation(() => ({ code: createPairingCode(), bot: telegram.status().bot })),
  connectTelegram: publicProcedure.mutation(() => telegram.connectHosted()),
  disconnectTelegram: publicProcedure.mutation(async () => {
    await telegram.disconnect();
    return telegram.status();
  }),
  exportRun: publicProcedure.input(z.object({ projectId: z.number() })).mutation(({ input }) => exportBundle(input.projectId)),
  doctor: publicProcedure.query(() => fullDoctor()),
  llmStatus: publicProcedure.query(() => llmStatus()),
  llm: router({
    providers: publicProcedure.query(() => ({ providers: providerSummaries(), routing: llmRouting(), transcriptionProvider: loadConfig().llm.transcriptionProvider, memory: loadConfig().memory, custom: loadConfig().llm.custom })),
    test: publicProcedure.input(z.object({ provider: providerId })).mutation(({ input }) => healthCheck(input.provider)),
    models: publicProcedure.input(z.object({ provider: providerId })).query(async ({ input }) => {
      try {
        return { models: (await providerFor(input.provider).models()).slice(0, 300), error: null };
      } catch (error) {
        return { models: [] as string[], error: (error as Error).message };
      }
    }),
  }),
  atlas: atlasRouter,
  setup: setupRouter,
});

export type AppRouter = typeof appRouter;
