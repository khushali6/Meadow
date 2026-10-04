import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../helpers";

const { filledEnvNames, missingEnv, writeEnvScaffold } = await import("../../server/meadow/harness/env");
const { touchesUi, uiGateApplies } = await import("../../server/meadow/harness/uigate");
const { compilePhasePrompt } = await import("../../server/meadow/harness/prompts");
const { saveConfig } = await import("../../server/meadow/config");

let env: ReturnType<typeof tempHome>;
let project: string;
beforeEach(() => {
  env = tempHome();
  project = path.join(env.root, "proj");
  fs.mkdirSync(project, { recursive: true });
});
afterEach(() => env.cleanup());

const planEnv = { env: { required: [{ name: "FREELLM_API_KEY", hint: "freellmapi.com dashboard" }, { name: "FREELLM_BASE_URL", hint: "" }], optional: [{ name: "SENTRY_DSN", hint: "error reporting" }] } };

describe("environment gate", () => {
  it("writes placeholders, gitignores .env.local and declares names in .env.example", () => {
    const changed = writeEnvScaffold(project, planEnv);
    expect(changed.sort()).toEqual([".env.example", ".gitignore"]);
    expect(fs.readFileSync(path.join(project, ".gitignore"), "utf8")).toContain(".env.local");
    const local = fs.readFileSync(path.join(project, ".env.local"), "utf8");
    expect(local).toMatch(/^FREELLM_API_KEY=$/m);
    expect(local).toMatch(/^SENTRY_DSN=$/m);
    expect(fs.statSync(path.join(project, ".env.local")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(project, ".env.example"), "utf8")).toContain("# freellmapi.com dashboard\nFREELLM_API_KEY=");
    expect(writeEnvScaffold(project, planEnv)).toEqual([]);
  });

  it("only counts variables that have a value, and never touches values the user wrote", () => {
    writeEnvScaffold(project, planEnv);
    expect(missingEnv(project, planEnv).map(item => item.name)).toEqual(["FREELLM_API_KEY", "FREELLM_BASE_URL"]);
    const file = path.join(project, ".env.local");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("FREELLM_API_KEY=", "FREELLM_API_KEY=sk-test-123").replace("FREELLM_BASE_URL=", 'FREELLM_BASE_URL=""'));
    expect(missingEnv(project, planEnv).map(item => item.name)).toEqual(["FREELLM_BASE_URL"]);
    writeEnvScaffold(project, planEnv);
    expect(fs.readFileSync(file, "utf8")).toContain("FREELLM_API_KEY=sk-test-123");
    expect([...filledEnvNames(project)]).toEqual(["FREELLM_API_KEY"]);
  });

  it("puts variable names, never values, into the phase prompt", () => {
    fs.writeFileSync(path.join(project, ".env.local"), "FREELLM_API_KEY=sk-secret-value\n");
    const phase = { id: "1", name: "API", dependsOn: [], tasks: ["Build it"], checks: [{ kind: "cmd" as const, cmd: "npm test" }], doneWhen: "done", agent: "backend" as const };
    const plan = { project: "p", goal: "A CLI", stack: ["python"], constraints: [], services: [], preview: null, phases: [phase], ui: null, ...planEnv, body: "" };
    const prompt = compilePhasePrompt({ plan, phase, projectPath: project, projectRules: "", previousSummaries: [], context: "" });
    expect(prompt).toContain("FREELLM_API_KEY, FREELLM_BASE_URL, SENTRY_DSN");
    expect(prompt).not.toContain("sk-secret-value");
    expect(prompt).toContain("You are the backend engineer");
  });
});

describe("design review gate", () => {
  const web = { preview: { command: "npm run dev", url: "http://localhost:5173", readyTimeoutS: 60, routes: ["/"] }, stack: ["react"], goal: "A dashboard" };

  it("runs only for UI file changes", () => {
    expect(touchesUi(["src/App.tsx"])).toBe(true);
    expect(touchesUi(["src/styles/tokens.css", "README.md"])).toBe(true);
    expect(touchesUi(["server/routes.ts", "package.json"])).toBe(false);
    expect(touchesUi([".meadow/design.md"])).toBe(false);
  });

  it("applies to web plans with a preview unless the phase opts out or design is off", () => {
    expect(uiGateApplies(web, {})).toBe(true);
    expect(uiGateApplies(web, { uiGate: false })).toBe(false);
    expect(uiGateApplies({ ...web, preview: null }, {})).toBe(false);
    expect(uiGateApplies({ ...web, stack: ["express"], goal: "A CLI tool" }, { agent: "ui" })).toBe(true);
    saveConfig({ harness: { design: false } });
    expect(uiGateApplies(web, {})).toBe(false);
  });
});
