import path from "node:path";
import { z } from "zod";
import { getInvestigation, listInvestigations } from "./meadow/atlas/agents";
import { mcpConfigSnippet } from "./meadow/atlas/mcpServer";
import { atlasStatus, createDemo, evaluate, nodeDetail, pathBetween, startIngest, startInvestigation, systemMap, toolCatalogue } from "./meadow/atlas/service";
import { listActions, runTool } from "./meadow/atlas/tools";
import { publicProcedure, router } from "./_core/trpc";
import { telegram, createPairingCode } from "./meadow/channels/telegram";
import { getSecret, loadConfig, saveConfig, setSecret } from "./meadow/config";
import { decide, listApprovals } from "./meadow/core/approvals";
import { fullDoctor, llmStatus } from "./meadow/doctor";
import { PROVIDERS } from "./meadow/llm/catalog";
import { healthCheck, llmRouting, providerFor, providerSummaries } from "./meadow/llm/router";
import { assertSelectableEngine, engineInfo } from "./meadow/engines/registry";
import { harness } from "./meadow/harness/runner";
import { handleAction, handleText } from "./meadow/intake/conversation";
import { improvePlan } from "./meadow/intake/llm";
import { parsePlan } from "./meadow/planning/format";
import { addNote, approvePlan, createProject, getPlan, getProject, savePlanVersion, updateProject } from "./meadow/projects";
import { embedDocs } from "./meadow/atlas/ingest";
import { renderBrief } from "./meadow/brief/brief";
import { planNextSteps, projectStatus } from "./meadow/brief/next";
import { bus } from "./meadow/core/events";
import { indexMemory, indexProject, memoryStatus, reembed, search } from "./meadow/rag/index";
import { exportBundle, notesFor, phaseDiff, phaseEvidence, planHistory, projectDetail, projectsOverview, usageToday } from "./meadow/service";
import { captureOnDemand } from "./meadow/visual/ondemand";

const DASHBOARD = { channel: "dashboard", chat: "local" } as const;

const providerId = z.enum(["freellmapi", "openai", "gemini", "anthropic", "openrouter", "ollama", "lmstudio", "custom"]);
const providerSettings = z.object({ baseUrl: z.string().url().max(300), model: z.string().max(200), embeddingModel: z.string().max(200), transcriptionModel: z.string().max(200) }).partial();

const configPatch = z.object({
  engine: z.object({ default: z.enum(["cursor", "claude_code", "codex", "gemini", "custom", "fake"]), model: z.string().nullable(), models: z.record(z.string(), z.string().max(120).nullable()), runTimeoutS: z.number().min(60).max(6 * 3600), noOutputTimeoutS: z.number().min(30).max(3600), claudeUseFreeLlmApi: z.boolean() }).partial().optional(),
  harness: z.object({ maxAttempts: z.number().int().min(1).max(10), checkTimeoutS: z.number().min(10).max(7200), massDeleteThreshold: z.number().int().min(1), phaseGate: z.enum(["auto", "ask"]) }).partial().optional(),
  budget: z.object({ phaseTokens: z.number().int().min(1000), dailyTokens: z.number().int().min(1000), phaseWallClockS: z.number().int().min(60) }).partial().optional(),
  telegram: z.object({ notificationLevel: z.enum(["all", "phases", "failures"]), quietHours: z.object({ enabled: z.boolean(), start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }), voiceReplies: z.boolean() }).partial().optional(),
  screenshots: z.object({ enabled: z.boolean() }).partial().optional(),
  llm: z.object({
    provider: providerId,
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
  atlas: z.object({
    rerank: z.boolean(),
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
    const plan = await approvePlan(input.planId);
    if (input.start) await harness.start(plan.project_id);
    return plan;
  }),
  improvePlan: publicProcedure.input(z.object({ planId: z.number() })).mutation(async ({ input }) => {
    const plan = getPlan(input.planId);
    return savePlanVersion(plan.project_id, await improvePlan(plan.raw_md), { source: "suggested" });
  }),
  planHistory: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => planHistory(input.projectId)),

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

  notes: publicProcedure.input(z.object({ projectId: z.number().nullable() })).query(({ input }) => notesFor(input.projectId)),
  addNote: publicProcedure.input(z.object({ projectId: z.number().nullable(), title: z.string().min(1).max(200), body: z.string().min(1).max(20_000) })).mutation(async ({ input }) => {
    const id = addNote({ ...input, source: "dashboard" });
    if (input.projectId) await indexMemory(input.projectId, input.title, `${input.title}\n${input.body}`);
    return { id };
  }),
  search: publicProcedure.input(z.object({ projectId: z.number(), query: z.string().min(1).max(500) })).query(({ input }) => search(input.projectId, input.query, 10)),
  reindex: publicProcedure.input(z.object({ projectId: z.number() })).mutation(({ input }) => indexProject(input.projectId, getProject(input.projectId).path)),
  projectStatus: publicProcedure.input(z.object({ projectId: z.number() })).query(({ input }) => {
    const status = projectStatus(input.projectId);
    return { ...status, briefText: renderBrief(status.brief, 6000), brief: { ...status.brief, spec: "" } };
  }),
  planNext: publicProcedure.input(z.object({ projectId: z.number(), request: z.string().max(2000).optional() })).mutation(async ({ input }) => {
    const result = await planNextSteps(input.projectId, input.request);
    bus.emitEvent({ projectId: input.projectId, type: "plan_ready", title: `Plan v${result.version} drafted with ${result.added.length} new phase${result.added.length === 1 ? "" : "s"}`, detail: result.added.join(", ") });
    return result;
  }),
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
    saveConfig(input);
    return safeSettings();
  }),
  setSecret: publicProcedure.input(z.object({ name: z.enum(["FREELLMAPI_API_KEY", "AGENT_OPENAI_API_KEY", "AGENT_GEMINI_API_KEY", "AGENT_ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "LLM_API_KEY", "TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "JIRA_API_TOKEN", "LINEAR_API_KEY"]), value: z.string().min(8).max(500) })).mutation(async ({ input }) => {
    setSecret(input.name, input.value.trim());
    if (input.name === "TELEGRAM_BOT_TOKEN") {
      telegram.stop();
      await telegram.start();
    }
    return safeSettings();
  }),
  pairTelegram: publicProcedure.mutation(() => ({ code: createPairingCode(), bot: telegram.status().bot })),
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
});

export type AppRouter = typeof appRouter;
