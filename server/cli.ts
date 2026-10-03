import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { createPairingCode } from "./meadow/channels/telegram";
import { getSecret, loadConfig, meadowHome, saveConfig, setSecret, type EngineName, type ProviderId } from "./meadow/config";
import { getDb } from "./meadow/core/db";
import { bus, type MeadowEvent } from "./meadow/core/events";
import { fullDoctor, llmStatus } from "./meadow/doctor";
import { effectiveDefaultEngine, selectableEngines } from "./meadow/engines/registry";
import { harness } from "./meadow/harness/runner";
import { isProviderId, PROVIDER_IDS, PROVIDERS, resolveProvider } from "./meadow/llm/catalog";
import { formatErrors, parsePlan } from "./meadow/planning/format";
import { approvePlan, createProject, findProject, getProject, savePlanVersion } from "./meadow/projects";
import { exportBundle, statusText } from "./meadow/service";

const HELP = `meadow — local-first agent that builds and tests code phase by phase

Usage:
  meadow setup [--yes] [--env-file F] One-time setup, no project needed: saves keys from the environment or F,
                                      picks and tests a model, installs and signs in a coding engine, pairs Telegram
                                      (--skip-model, --skip-engine, --skip-telegram)
  meadow init                         Guided setup: detects this repo, model providers, builds the graph, runs checks
  meadow update [--yes]               Check for a signed update, verify it, back up and install
  meadow doctor                       Check engines, agent model, memory, git and optional extras
  meadow selftest                     Check guardrails, the engine broker and connected services (no changes made)
  meadow start [--port N] [--dev]     Start the daemon (dashboard + Telegram)
  meadow run <PLAN.md> [--engine E]   Run a plan from the command line (no Telegram needed)
  meadow plan validate <PLAN.md>      Validate a plan file
  meadow status [project]             Show project status
  meadow pair                         Print a new Telegram pairing code
  meadow export-run <project> [--out file.json]

CodeAtlas (engineering intelligence over your repos):
  meadow mcp [--project P]            MCP server on stdio for Cursor, Claude Code and other clients
  meadow atlas demo [dir]             Generate the AcmePay demo repo, register and index it
  meadow atlas ingest <project>       Build or refresh the knowledge graph
  meadow atlas ask <project> "<q>"    Investigate (--mode agentic|hybrid|graph|vector)
  meadow atlas eval <project>         Benchmark vector, graph, hybrid and agentic retrieval
  meadow atlas tools                  List the tools agents and MCP clients can call
  meadow atlas mcp-config             Print the MCP config for Cursor and Claude Code
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const mark = (ok: boolean, optional?: boolean) => (ok ? "✓" : optional ? "·" : "✗");

async function doctor() {
  const report = await fullDoctor();
  console.log("System");
  for (const check of report.system) console.log(`  ${mark(check.ok, check.optional)} ${check.name}: ${check.detail}${!check.ok && check.fix ? `\n      fix: ${check.fix}` : ""}`);
  console.log("\nEngines");
  for (const engine of report.engines) {
    console.log(`  ${mark(engine.ready)} ${engine.engine}${engine.version ? ` (${engine.version})` : ""}${engine.engine === report.defaultEngine ? " [default]" : ""}`);
    for (const check of engine.checks) console.log(`      ${mark(check.ok)} ${check.name}: ${check.detail}${!check.ok && check.fix ? `\n          fix: ${check.fix}` : ""}`);
  }
  const required = report.system.filter(check => !check.optional && !check.ok);
  const engineReady = report.engines.find(engine => engine.engine === report.defaultEngine)?.ready;
  if (!engineReady) console.log(`\nThe default engine (${report.defaultEngine}) is not ready. Fix it or pick another with \`meadow init\`.`);
  return required.length === 0 && Boolean(engineReady);
}

async function init() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback = "") => (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim() || fallback;
  const config = loadConfig();
  console.log(`Meadow setup. Everything stays on this machine (${meadowHome()}).\n`);
  getDb();
  const { detectProject, profileLines } = await import("./meadow/setup/detect");
  const { scanProviders } = await import("./meadow/setup/providers");
  const cwd = process.cwd();
  const profile = detectProject(cwd);
  const looksLikeRepo = profile.git.repo || profile.markers.length > 0;
  if (looksLikeRepo) {
    console.log(`Detected in ${cwd}:`);
    for (const line of profileLines(profile)) console.log(`  ✓ ${line}`);
    console.log("");
  }

  const projectsDir = await ask("Projects folder (for new projects)", config.projectsDir);
  saveConfig({ projectsDir });
  const scan = await scanProviders();
  for (const found of scan.providers.filter(item => item.available)) console.log(`  ✓ ${found.name}${found.models.length ? ` (${found.models.slice(0, 3).join(", ")}${found.models.length > 3 ? "…" : ""})` : ""}`);
  if (scan.note) console.log(`  · ${scan.note}`);
  console.log(`\nAgent model (planning, questions, summaries). Memory always stays on this machine.\n  ${PROVIDER_IDS.map(id => `${id}${PROVIDERS[id].type === "cloud" ? " (cloud)" : PROVIDERS[id].type === "local" ? " (local)" : ""}`).join(" | ")}`);
  let provider = await ask("Provider", scan.recommended ?? config.llm.provider);
  if (!isProviderId(provider)) {
    console.log(`  Unknown provider ${provider}. Using freellmapi.`);
    provider = "freellmapi";
  }
  const def = PROVIDERS[provider as ProviderId];
  const current = resolveProvider(def.id);
  const settings: Record<string, string> = {};
  if (def.type !== "cloud") settings.baseUrl = await ask(`${def.name} base URL`, current.baseUrl);
  const found = scan.providers.find(item => item.id === def.id);
  if (found?.pickReason) console.log(`  ${found.pickReason}`);
  settings.model = await ask("Chat model", found?.recommendedModel ?? (current.model || def.defaults.model));
  if (found?.embeddingModel && (await ask(`Use ${found.embeddingModel} for memory search? (Y/n)`, "y")).toLowerCase() !== "n") {
    settings.embeddingModel = found.embeddingModel;
    saveConfig({ memory: { embeddings: "provider", embeddingProvider: def.id } });
  }
  if (def.id === "freellmapi") saveConfig({ llm: { provider: def.id, ...settings } });
  else saveConfig({ llm: { provider: def.id, providers: { [def.id]: settings } } });
  if (def.secret && (!getSecret(def.secret) || (await ask(`Replace the stored ${def.name} key? (y/N)`, "n")).toLowerCase() === "y")) {
    const key = await ask(`${def.name} API key${def.keyRequired ? "" : " (optional)"} — ${def.keyHint}`);
    if (key) setSecret(def.secret, key);
  }
  const llm = await llmStatus();
  console.log(`  ${mark(llm.ok)} ${llm.detail}`);

  const available = selectableEngines();
  let engine = (await ask(`Default engine (${available.join(" | ")})`, effectiveDefaultEngine())) as EngineName;
  if (!available.includes(engine)) {
    console.log(`  ${engine === "claude_code" ? "Claude Code is coming soon." : `Unknown engine ${engine}.`} Using ${effectiveDefaultEngine()}.`);
    engine = effectiveDefaultEngine() as EngineName;
  }
  saveConfig({ engine: { default: engine } });
  if (engine === "custom") {
    const command = await ask('Command to run (gets $MEADOW_PROMPT / $MEADOW_PROMPT_FILE), e.g. aider --yes-always --message-file "$MEADOW_PROMPT_FILE"', config.engine.custom.command);
    const label = await ask("Name to show for it", config.engine.custom.label);
    saveConfig({ engine: { custom: { command, label } } });
  }
  const model = await ask(`Model for ${engine} (blank = engine default)`, config.engine.models?.[engine] ?? "");
  saveConfig({ engine: { models: { [engine]: model || null } } });

  if ((await ask("Set up Telegram? (Y/n)", "y")).toLowerCase() !== "n") {
    getDb();
    const { relayUrl, requestLink } = await import("./meadow/channels/relay");
    const useHosted = relayUrl() && (await ask("Connect to the Meadow bot with one tap? (Y/n — n uses your own bot)", "y")).toLowerCase() !== "n";
    if (useHosted) {
      try {
        const link = await requestLink(createPairingCode("link"));
        saveConfig({ telegram: { mode: "hosted", ownerId: null } });
        console.log(`\n  Open this link on your phone and tap Start:\n  ${link.link}\n  It works once, for 15 minutes. Meadow finishes connecting when it's running (\`meadow start\`).\n`);
      } catch (error) {
        console.log(`\n  Couldn't reach the Meadow bot: ${(error as Error).message}\n  You can connect later from Runtime settings → Telegram.\n`);
      }
    } else if (!getSecret("TELEGRAM_BOT_TOKEN") || (await ask("Replace the stored bot token? (y/N)", "n")).toLowerCase() === "y") {
      const token = await ask("Bot token from @BotFather");
      if (token) {
        setSecret("TELEGRAM_BOT_TOKEN", token);
        saveConfig({ telegram: { mode: "own" } });
      }
    }
    if (!useHosted && getSecret("TELEGRAM_BOT_TOKEN")) {
      const code = createPairingCode();
      console.log(`\n  Pairing code: ${code}\n  Start Meadow (\`meadow start\`), then send this code to your bot within 15 minutes.\n  Only that Telegram account will be able to control Meadow. Turn on two-step verification in Telegram.\n`);
    }
  }
  let registered: string | null = null;
  if (looksLikeRepo && (await ask(`Set up ${cwd} as a Meadow project? (Y/n)`, "y")).toLowerCase() !== "n") {
    rl.close();
    const { registerRepository, buildKnowledge, generateInitialPlan, markStep } = await import("./meadow/setup/onboarding");
    const { runBaseline } = await import("./meadow/setup/verify");
    try {
      const { project } = await registerRepository(cwd);
      registered = project.name;
      markStep("repository", "done", project.path, project.id);
      console.log(`\nBuilding CodeAtlas for ${project.name}…`);
      const { graph, memory } = await buildKnowledge(project.id, (step, detail) => console.log(`  ${step.padEnd(10)} ${detail}`));
      console.log(`  ✓ ${graph.services} services · ${graph.functions} functions · ${graph.apis} APIs · ${graph.tables} tables · ${memory.chunks} memory chunks`);
      markStep("codeatlas", "done", `${graph.functions} functions`);
      markStep("memory", "done", `${memory.chunks} chunks`);
      if (profile.commands.length) {
        console.log("\nRunning the detected checks once (baseline)…");
        const baseline = await runBaseline(project.id, result => console.log(`  ${result.passed ? "✓" : "✗"} ${result.cmd} (${(result.durationMs / 1000).toFixed(1)}s)`));
        markStep("verify", "done", `${baseline.results.filter(result => result.passed).length}/${baseline.results.length} pass`);
      }
      const plan = generateInitialPlan(project.id);
      markStep("plan", "done", `Plan v${plan.version}`);
      console.log(`\n  ✓ Initial plan v${plan.version} drafted from the analysis. Review and approve it in the dashboard.`);
    } catch (error) {
      console.log(`  ✗ ${(error as Error).message}`);
    }
  } else rl.close();
  console.log("\nRunning doctor…\n");
  await doctor();
  if (registered) (await import("./meadow/setup/onboarding")).completeOnboarding();
  console.log(`\nNext: \`meadow start\`${registered ? `, then review the plan for ${registered}` : ""}.`);
}

/** `meadow setup`: everything Meadow needs before any project exists. Safe to run again; finished parts are kept. */
async function setup(args: string[]): Promise<number> {
  const { runSetup } = await import("./meadow/setup/bootstrap");
  const interactive = Boolean(process.stdin.isTTY) && !args.includes("--yes") && !args.includes("--non-interactive");
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout, terminal: true }) : null;
  let muted = false;
  const realWrite = process.stdout.write.bind(process.stdout);
  if (rl) {
    // While a secret is typed, echo `*` per character and drop readline's redraws, so the value never reaches the screen.
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (!muted) return (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      if (/[\r\n]/.test(text)) return realWrite("\n");
      if (/^[^\x00-\x1f\x7f]+$/.test(text)) return realWrite("*".repeat([...text].length));
      return true;
    }) as typeof process.stdout.write;
  }
  const ask = async (question: string, fallback = "", options: { secret?: boolean } = {}) => {
    if (!rl) return fallback;
    const prompt = fallback ? `${question} [${fallback}]: ` : `${question}: `;
    // readline writes the prompt synchronously inside question(); only what's typed after it is masked.
    const answer = rl.question(prompt);
    muted = Boolean(options.secret);
    try {
      return (await answer).trim() || fallback;
    } finally {
      muted = false;
    }
  };
  const waitOrSkip = async <T,>(work: Promise<T>, prompt: string): Promise<T | null> => {
    if (!rl) return work;
    const abort = new AbortController();
    const skipped = rl.question(`${prompt}\n`, { signal: abort.signal }).then(() => null, () => null);
    const result = await Promise.race([work, skipped]);
    abort.abort();
    return result;
  };
  const skip = (["model", "engine", "telegram"] as const).filter(step => args.includes(`--skip-${step}`));
  try {
    const results = await runSetup({ interactive, yes: args.includes("--yes"), log: (line = "") => console.log(line), ask, waitOrSkip }, { envFile: flag(args, "--env-file"), skip: [...skip] });
    console.log(`\nNext: \`meadow start\` opens the dashboard. Add a project there, or run \`meadow init\` inside a repository.`);
    return results.engine === false ? 2 : 0;
  } finally {
    rl?.close();
    process.stdout.write = realWrite as typeof process.stdout.write;
  }
}

function printEvent(event: MeadowEvent) {
  const time = event.ts.slice(11, 19);
  const detail = ["check_result", "phase_blocked", "error"].includes(event.type) && event.detail ? `\n    ${event.detail.split("\n").slice(0, 8).join("\n    ")}` : "";
  console.log(`${time} ${event.type.padEnd(18)} ${event.title}${detail}`);
}

async function runPlanFile(file: string, args: string[]) {
  const raw = fs.readFileSync(path.resolve(file), "utf8");
  const parsed = parsePlan(raw);
  if (!parsed.ok) {
    console.error(formatErrors(parsed.errors));
    return 1;
  }
  getDb();
  harness.recoverOnStartup();
  const engine = flag(args, "--engine");
  const name = flag(args, "--project") ?? parsed.plan.project;
  const project = findProject(name) ?? (await createProject({ name, engine, description: parsed.plan.goal }));
  const plan = savePlanVersion(project.id, raw, { source: "user" });
  await approvePlan(plan.id);
  console.log(`Project ${project.name} at ${project.path}\nPlan v${plan.version} approved; running on ${engine ?? project.engine}.\n`);
  const done = new Promise<string>(resolve => {
    bus.onEvent(event => {
      if (event.projectId !== project.id) return;
      printEvent(event);
      if (event.type === "execution_finished") resolve(String(event.payload?.status));
      if (event.type === "control" && ["blocked", "paused", "waiting"].includes(String(event.payload?.status))) resolve(String(event.payload?.status));
    });
  });
  process.on("SIGINT", () => void harness.stop(project.id));
  await harness.start(project.id, { engine });
  const status = await done;
  console.log(`\n${statusText(project.id)}`);
  return status === "completed" ? 0 : 1;
}

function exportRun(name: string, out?: string) {
  const project = getProject(name);
  const file = out ?? `${project.name}-run-export.json`;
  fs.writeFileSync(file, JSON.stringify(exportBundle(project.id), null, 2));
  console.log(`Wrote ${file}`);
}

async function atlas(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  getDb();
  if (sub === "demo") {
    const { generateAcmePay } = await import("./meadow/atlas/demo");
    const { ingestProject } = await import("./meadow/atlas/ingest");
    const name = flag(rest, "--name") ?? "acmepay";
    const dir = path.resolve(rest[0] && !rest[0].startsWith("--") ? rest[0] : path.join(loadConfig().projectsDir, name));
    const { commits, tags } = await generateAcmePay(dir);
    const project = await createProject({ name, path: dir, description: "AcmePay demo for CodeAtlas" });
    const stats = await ingestProject(project.id, (step, detail) => console.log(`  ${step.padEnd(10)} ${detail ?? ""}`));
    console.log(`\nAcmePay is at ${dir} (${commits} commits, releases ${tags.join(", ")}).\nIndexed ${stats.services} services, ${stats.functions} functions, ${stats.apis} APIs, ${stats.incidents} incidents in ${stats.ms} ms.\n\nTry:\n  meadow atlas ask ${name} "Why did payment API timeouts start after release v2.4.0?"\n  meadow atlas eval ${name}`);
    return 0;
  }
  if (sub === "ingest" && rest[0]) {
    const { ingestProject } = await import("./meadow/atlas/ingest");
    const stats = await ingestProject(getProject(rest[0]).id, (step, detail) => console.log(`  ${step.padEnd(10)} ${detail ?? ""}`));
    console.log(JSON.stringify(stats, null, 2));
    return 0;
  }
  if (sub === "ask" && rest[0] && rest[1]) {
    const { investigate } = await import("./meadow/atlas/agents");
    const { ingestProject } = await import("./meadow/atlas/ingest");
    const { graphStats } = await import("./meadow/atlas/store");
    const project = getProject(rest[0]);
    if (!graphStats(project.id).lastIngest) await ingestProject(project.id);
    const off = bus.onEvent(event => {
      if (event.type === "atlas_trace" && event.projectId === project.id) console.log(`  · ${event.title}: ${event.detail.split("\n")[0].slice(0, 140)}`);
    });
    const result = await investigate(project.id, rest[1], { mode: (flag(rest, "--mode") as "agentic" | undefined) ?? "agentic", actor: "cli" });
    off();
    console.log(`\n${result.answer}\n`);
    for (const e of result.evidence) console.log(`  [${e.n}] ${e.title}${e.path ? ` — ${e.path}` : ""}`);
    console.log(`\nVerifier: ${result.verifier.supported}/${result.verifier.total} claims supported · ${result.writer === "llm" ? "LLM writer" : "rule-based writer (agent model unavailable)"} · ${result.ms} ms`);
    for (const finding of result.findings) console.log(`Path: ${finding.text}`);
    return 0;
  }
  if (sub === "eval" && rest[0]) {
    const { runEval, formatReport } = await import("./meadow/atlas/eval");
    const report = await runEval(getProject(rest[0]).id, { onProgress: line => console.log(`  ${line}`) });
    console.log(`\n${formatReport(report)}`);
    const out = flag(rest, "--json");
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
    return 0;
  }
  if (sub === "tools") {
    const { TOOLS } = await import("./meadow/atlas/tools");
    for (const tool of TOOLS) console.log(`  ${tool.name.padEnd(24)} ${tool.risk.padEnd(5)} ${tool.description}`);
    return 0;
  }
  if (sub === "mcp-config") {
    const { mcpConfigSnippet } = await import("./meadow/atlas/mcpServer");
    const snippet = mcpConfigSnippet(path.resolve(process.argv[1]));
    console.log(`Cursor — add to ${snippet.cursor.file}:\n${JSON.stringify(snippet.cursor.json, null, 2)}\n\nClaude Code:\n  ${snippet.claudeCode.command}`);
    return 0;
  }
  console.log(HELP);
  return 1;
}

async function update(yes: boolean): Promise<number> {
  const { checkForUpdate, downloadUpdate } = await import("./meadow/core/updates");
  const result = await checkForUpdate();
  if (result.status === "not_configured") {
    console.log(`Meadow ${result.current}. Signed updates are not configured for this build; update with your package manager.`);
    return 0;
  }
  if (result.status === "error") {
    console.error(`Update check failed: ${result.error}`);
    return 1;
  }
  if (result.status === "up_to_date") {
    console.log(`Meadow ${result.current} is up to date.`);
    return 0;
  }
  console.log(`Meadow ${result.latest} is available (you have ${result.current}).${result.notes ? `\n\n${result.notes}\n` : ""}`);
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Download, verify and install it? (y/N): ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y") return 0;
  }
  const file = await downloadUpdate(result);
  console.log(`  ✓ Signature and checksum verified (${path.basename(file)})`);
  const backup = getDb().backup(`pre-${result.latest}`);
  if (backup) console.log(`  ✓ Database backed up to ${backup}`);
  const { spawnSync } = await import("node:child_process");
  const install = spawnSync("npm", ["install", "-g", file], { stdio: "inherit" });
  if (install.status !== 0) {
    console.error("  ✗ Install failed. Your current version and data are unchanged.");
    return 1;
  }
  console.log("  ✓ Installed. Restart Meadow (`meadow start`); migrations run with a backup and `meadow doctor` checks the result.");
  return 0;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "mcp": {
      const { startMcpServer } = await import("./meadow/atlas/mcpServer");
      await startMcpServer({ project: flag(args, "--project") });
      return null;
    }
    case "broker": {
      const { startBrokerServer } = await import("./meadow/guard/brokerServer");
      await startBrokerServer();
      return null;
    }
    case "atlas":
      return atlas(args);
    case "init":
      await init();
      return 0;
    case "setup":
      return setup(args);
    case "doctor":
      return (await doctor()) ? 0 : 1;
    case "selftest": {
      const { runSelftest } = await import("./meadow/selftest");
      const results = await runSelftest();
      let area = "";
      for (const result of results) {
        if (result.area !== area) console.log(`${area ? "\n" : ""}${(area = result.area)[0].toUpperCase()}${result.area.slice(1)}`);
        console.log(`  ${mark(result.ok)} ${result.name}${result.detail ? ` · ${result.detail}` : ""}`);
      }
      const failed = results.filter(result => !result.ok).length;
      console.log(failed ? `\n${failed} check${failed === 1 ? "" : "s"} failed.` : "\nAll checks passed.");
      return failed ? 1 : 0;
    }
    case "start": {
      const { startDaemon } = await import("./_core/index");
      const port = flag(args, "--port");
      if (port !== undefined && !(/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536)) throw new Error(`--port must be a number between 1 and 65535 (got "${port}").`);
      await startDaemon({ port: port ? Number(port) : undefined, dev: args.includes("--dev") || process.env.NODE_ENV === "development" });
      return null;
    }
    case "run":
      if (!args[0]) break;
      return runPlanFile(args[0], args);
    case "plan":
      if (args[0] === "validate" && args[1]) {
        const result = parsePlan(fs.readFileSync(path.resolve(args[1]), "utf8"));
        if (result.ok) {
          console.log(`✓ Valid plan: ${result.plan.phases.length} phases`);
          for (const warning of result.warnings) console.log(`  note: ${warning.message}`);
          return 0;
        }
        console.error(formatErrors(result.errors));
        return 1;
      }
      break;
    case "status": {
      getDb();
      const target = args[0] ? findProject(args[0]) : undefined;
      const rows = target ? [target] : getDb().all<{ id: number }>("SELECT id FROM projects ORDER BY updated_at DESC");
      if (!rows.length) console.log("No projects yet.");
      for (const row of rows) console.log(statusText(row.id));
      return 0;
    }
    case "update":
      return update(args.includes("--yes"));
    case "pair":
      getDb();
      console.log(`Pairing code: ${createPairingCode()} (valid 15 minutes). Send it to your bot.`);
      return 0;
    case "export-run":
      if (!args[0]) break;
      getDb();
      exportRun(args[0], flag(args, "--out"));
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    case "version":
    case "--version":
    case "-v":
      console.log(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
      return 0;
  }
  console.log(HELP);
  return 1;
}

main().then(code => {
  if (code !== null) process.exit(code);
}).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
