import fs from "node:fs";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../helpers";

const { loadConfig, saveConfig, homePath, resetConfigCache } = await import("../../server/meadow/config");
const { diagnoseFailure, teamStatus } = await import("../../server/meadow/harness/orchestrator");

const KEYS = ["AGENT_ANTHROPIC_API_KEY", "FREELLMAPI_API_KEY", "MEADOW_SUPERVISOR_PROVIDER", "MEADOW_SUPERVISOR_MODEL"];
let env: { cleanup: () => void };
let saved: Record<string, string | undefined>;

beforeEach(() => {
  env = tempHome();
  saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  resetConfigCache();
});
afterEach(() => {
  for (const key of KEYS) saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key]);
  resetConfigCache();
  env.cleanup();
});

describe("supervisor provider chain", () => {
  it("defaults to Ollama, then FreeLLMAPI, then Claude", () => {
    expect(loadConfig().harness.supervisor.chain).toEqual(["ollama", "freellmapi", "anthropic"]);
    expect(loadConfig().harness.supervisor.models.ollama).toBe("qwen2.5-coder:7b");
  });

  it("upgrades the old single provider/model setting and drops it on save", () => {
    fs.writeFileSync(homePath("config.json"), JSON.stringify({ harness: { supervisor: { enabled: true, provider: "anthropic", model: "claude-haiku-4-5" } } }));
    resetConfigCache();
    const supervisor = loadConfig().harness.supervisor;
    expect(supervisor.chain).toEqual(["anthropic", "ollama", "freellmapi"]);
    expect(supervisor.models.anthropic).toBe("claude-haiku-4-5");
    saveConfig({ harness: { supervisor: { chain: ["freellmapi", "anthropic"] } } });
    expect(loadConfig().harness.supervisor.chain).toEqual(["freellmapi", "anthropic"]);
    expect(JSON.parse(fs.readFileSync(homePath("config.json"), "utf8")).harness.supervisor.provider).toBeUndefined();
  });

  it("env picks the order and the first provider's model", () => {
    process.env.MEADOW_SUPERVISOR_PROVIDER = "anthropic, ollama";
    process.env.MEADOW_SUPERVISOR_MODEL = "claude-haiku-4-5";
    resetConfigCache();
    const supervisor = loadConfig().harness.supervisor;
    expect(supervisor.chain).toEqual(["anthropic", "ollama"]);
    expect(supervisor.models).toMatchObject({ anthropic: "claude-haiku-4-5", ollama: "qwen2.5-coder:7b" });
  });

  it("falls through a dead Ollama to the next provider with that provider's own model", async () => {
    const requests: Array<{ model: string; auth: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "auto" }] }));
        requests.push({ model: JSON.parse(body).model, auth: req.headers.authorization });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "gateway-pick", choices: [{ message: { content: JSON.stringify({ action: "retry", diagnosis: "listItems maps over undefined.", hint: "Default items to [] in src/api.js." }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    process.env.FREELLMAPI_API_KEY = "test-gateway-key";
    saveConfig({ llm: { baseUrl: `http://127.0.0.1:${port}/v1`, providers: { ollama: { baseUrl: "http://127.0.0.1:9/v1" } } }, harness: { supervisor: { models: { freellmapi: "qwen-coder-via-gateway" } } } });
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const verdict = await diagnoseFailure({
        plan: { title: "Chain", stack: ["node"], phases: [] } as never,
        phase: { id: 1, name: "API", goal: "List items", agent: "backend", tasks: ["GET /api/items"], checks: [], dependsOn: [] } as never,
        projectPath: process.cwd(),
        failing: { label: "npm test", exitCode: 1, output: "TypeError: Cannot read properties of undefined (reading 'map')" },
        attempt: { n: 1, max: 3 },
        previous: [],
      });
      expect(verdict).toMatchObject({ action: "retry", hint: "Default items to [] in src/api.js.", by: "freellmapi gateway-pick" });
      expect(requests[0]).toEqual({ model: "qwen-coder-via-gateway", auth: "Bearer test-gateway-key" });
    } finally {
      process.env.VITEST = vitest;
      server.close();
    }
  });

  it("reports keyless cloud providers as needing a key, without calling them", async () => {
    saveConfig({ llm: { providers: { ollama: { baseUrl: "http://127.0.0.1:9/v1" } } }, harness: { supervisor: { models: { anthropic: "claude-haiku-4-5" } } } });
    const status = await teamStatus();
    const byId = Object.fromEntries(status.supervisor.chain.map(member => [member.provider, member]));
    expect(byId.anthropic).toMatchObject({ configured: false, needsKey: "AGENT_ANTHROPIC_API_KEY", model: "claude-haiku-4-5", reachable: false });
    expect(byId.freellmapi).toMatchObject({ configured: false, needsKey: "FREELLMAPI_API_KEY" });
    expect(byId.ollama).toMatchObject({ configured: true, reachable: false, needsKey: null });
    expect(status.supervisor.active).toBeNull();
  });
});
