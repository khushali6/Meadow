import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { createPairingCode } from "./meadow/channels/telegram";
import { getSecret, loadConfig, meadowHome, saveConfig, setSecret, type EngineName } from "./meadow/config";
import { getDb } from "./meadow/core/db";
import { bus, type MeadowEvent } from "./meadow/core/events";
import { fullDoctor, llmStatus } from "./meadow/doctor";
import { harness } from "./meadow/harness/runner";
import { formatErrors, parsePlan } from "./meadow/planning/format";
import { approvePlan, createProject, findProject, getProject, savePlanVersion } from "./meadow/projects";
import { exportBundle, statusText } from "./meadow/service";

const HELP = `meadow — local-first agent that builds and tests code phase by phase

Usage:
  meadow init                         Guided setup (FreeLLMAPI key, engine, Telegram pairing)
  meadow doctor                       Check engines, FreeLLMAPI, git and optional extras
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

  const projectsDir = await ask("Projects folder", config.projectsDir);
  const baseUrl = await ask("FreeLLMAPI base URL", config.llm.baseUrl);
  saveConfig({ projectsDir, llm: { baseUrl } });
  if (!getSecret("FREELLMAPI_API_KEY") || (await ask("Replace the stored FreeLLMAPI key? (y/N)", "n")).toLowerCase() === "y") {
    const key = await ask("FreeLLMAPI unified key (from the Keys page at http://127.0.0.1:3001)");
    if (key) setSecret("FREELLMAPI_API_KEY", key);
  }
  const llm = await llmStatus();
  console.log(`  ${mark(llm.ok)} ${llm.detail}`);

  const engine = (await ask("Default engine (cursor | claude_code | codex | gemini | custom | fake)", config.engine.default)) as EngineName;
  saveConfig({ engine: { default: engine } });
  if (engine === "custom") {
    const command = await ask('Command to run (gets $MEADOW_PROMPT / $MEADOW_PROMPT_FILE), e.g. aider --yes-always --message-file "$MEADOW_PROMPT_FILE"', config.engine.custom.command);
    const label = await ask("Name to show for it", config.engine.custom.label);
    saveConfig({ engine: { custom: { command, label } } });
  }
  const model = await ask(`Model for ${engine} (blank = engine default)`, config.engine.models?.[engine] ?? "");
  saveConfig({ engine: { models: { [engine]: model || null } } });
  if (engine === "claude_code") {
    const viaGateway = (await ask("Route Claude Code through FreeLLMAPI (free models)? (y/N)", "n")).toLowerCase() === "y";
    saveConfig({ engine: { claudeUseFreeLlmApi: viaGateway } });
  }

  if ((await ask("Set up Telegram? (Y/n)", "y")).toLowerCase() !== "n") {
    if (!getSecret("TELEGRAM_BOT_TOKEN") || (await ask("Replace the stored bot token? (y/N)", "n")).toLowerCase() === "y") {
      const token = await ask("Bot token from @BotFather");
      if (token) setSecret("TELEGRAM_BOT_TOKEN", token);
    }
    if (getSecret("TELEGRAM_BOT_TOKEN")) {
      getDb();
      const code = createPairingCode();
      console.log(`\n  Pairing code: ${code}\n  Start Meadow (\`meadow start\`), then send this code to your bot within 15 minutes.\n  Only that Telegram account will be able to control Meadow. Turn on two-step verification in Telegram.\n`);
    }
  }
  rl.close();
  console.log("\nRunning doctor…\n");
  await doctor();
  console.log("\nNext: `meadow start`.");
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
    console.log(`\nVerifier: ${result.verifier.supported}/${result.verifier.total} claims supported · ${result.writer === "llm" ? "LLM writer" : "rule-based writer (FreeLLMAPI unavailable)"} · ${result.ms} ms`);
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

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "mcp": {
      const { startMcpServer } = await import("./meadow/atlas/mcpServer");
      await startMcpServer({ project: flag(args, "--project") });
      return null;
    }
    case "atlas":
      return atlas(args);
    case "init":
      await init();
      return 0;
    case "doctor":
      return (await doctor()) ? 0 : 1;
    case "start": {
      const { startDaemon } = await import("./_core/index");
      const port = flag(args, "--port");
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
