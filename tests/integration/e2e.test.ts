import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../helpers";
import { SPLIT_CASES, splitApp } from "../fixtures/e2eApp";

const { findBrowser } = await import("../../server/meadow/visual/browser");
const { E2E_FILE, failureReport, loadScenarios, runEndToEnd } = await import("../../server/meadow/visual/e2e");
const { detectLaunch, launchApp } = await import("../../server/meadow/visual/launch");
const { runAcceptance, acceptancePhase } = await import("../../server/meadow/harness/acceptance");
const { createProject } = await import("../../server/meadow/projects");
const git = await import("../../server/meadow/core/git");

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
  delete process.env.MEADOW_ENGINE;
});
afterEach(() => env.cleanup());

const write = (root: string, files: Record<string, string>) => {
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
};

describe("the end-to-end test file", () => {
  it("explains a missing, invalid or assertion-free file to the engine", async () => {
    const project = await createProject({ name: "scenarios", engine: "fake" });
    expect(loadScenarios(project.path).problem).toMatch(/meadow\.e2e\.json is missing/);
    fs.writeFileSync(path.join(project.path, E2E_FILE), "{ not json");
    expect(loadScenarios(project.path).problem).toMatch(/not valid JSON/);
    fs.writeFileSync(path.join(project.path, E2E_FILE), JSON.stringify({ cases: [{ name: "x", steps: [{ tap: "Go" }] }] }));
    expect(loadScenarios(project.path).problem).toMatch(/is invalid: cases\.0\.steps\.0/);
    fs.writeFileSync(path.join(project.path, E2E_FILE), JSON.stringify({ cases: [{ name: "Looks only", steps: [{ click: "Go" }] }] }));
    expect(loadScenarios(project.path).problem).toMatch(/needs at least one "expect" step.*Looks only/);
    fs.writeFileSync(path.join(project.path, E2E_FILE), JSON.stringify(SPLIT_CASES));
    const loaded = loadScenarios(project.path);
    expect(loaded.problem).toBeNull();
    expect(loaded.cases[0]).toMatchObject({ path: "/", allowErrors: false, viewport: "desktop" });
  });

  it("only allows same-site paths in goto steps", async () => {
    const project = await createProject({ name: "offsite", engine: "fake" });
    fs.writeFileSync(path.join(project.path, E2E_FILE), JSON.stringify({ cases: [{ name: "x", steps: [{ goto: "https://example.com" }, { expect: "y" }] }] }));
    expect(loadScenarios(project.path).problem).toMatch(/invalid/);
  });

  it("makes the built-in phase reuse the plan's checks and ask for the test file", () => {
    const phase = acceptancePhase({ goal: "Split bills", phases: [{ checks: [{ kind: "cmd", cmd: "npm test" }, { kind: "http", path: "/", expectStatus: 200 }] }, { checks: [{ kind: "cmd", cmd: "npm test" }] }] } as never);
    expect(phase.checks).toEqual([{ kind: "cmd", cmd: "npm test" }]);
    expect(phase.tasks.join("\n")).toContain(E2E_FILE);
    expect(phase.tasks.join("\n")).toMatch(/port another program may own/);
  });
});

describe("running the app as a user would", () => {
  it("doesn't override PORT for Node apps and finds the URL the app prints", async () => {
    const project = await createProject({ name: "noport", engine: "fake" });
    write(project.path, { ...splitApp(false), "server.js": `require("http").createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<p>" + (process.env.PORT ?? "no PORT") + "</p>"); }).listen(0, "127.0.0.1", function () { console.log("listening on port " + this.address().port); });` });
    const spec = await detectLaunch(project.path, null);
    expect(spec).toMatchObject({ kind: "command", injectPort: false });
    const handle = await launchApp(spec!, project.path);
    try {
      expect(await (await fetch(handle.url)).text()).toContain("no PORT");
    } finally {
      handle.stop();
    }
  });
});

describe("browser test cases", async () => {
  const browser = process.env.MEADOW_TEST_BROWSER === "0" ? null : await findBrowser();

  it.skipIf(!browser)("passes working flows and catches an API that answers with a web page", async () => {
    const project = await createProject({ name: "split", engine: "fake" });
    write(project.path, splitApp(false));
    const cases = loadScenarios(project.path).cases;
    expect(cases).toEqual([]);
    write(project.path, { [E2E_FILE]: JSON.stringify(SPLIT_CASES) });
    const scenario = loadScenarios(project.path).cases;

    let handle = await launchApp((await detectLaunch(project.path, null))!, project.path);
    try {
      const results = await runEndToEnd({ browser: browser!, baseUrl: handle.url, cases: scenario, projectPath: project.path, projectId: project.id, phaseId: null, folder: "e2e-good" });
      expect(results.map(result => [result.name, result.passed, result.failure])).toEqual([
        ["The app loads without errors", true, null],
        ["Splits a bill equally", true, null],
        ["Rejects an empty amount", true, null],
      ]);
      expect(results[1].screenshots.map(shot => shot.label)).toEqual(["Split result"]);
      expect(results[2].screenshots.map(shot => shot.label)).toEqual(["Result"]);
      for (const result of results) for (const shot of result.screenshots) expect(fs.statSync(shot.path).size).toBeGreaterThan(1000);
    } finally {
      handle.stop();
    }

    write(project.path, splitApp(true));
    handle = await launchApp((await detectLaunch(project.path, null))!, project.path);
    try {
      const results = await runEndToEnd({ browser: browser!, baseUrl: handle.url, cases: scenario, projectPath: project.path, projectId: project.id, phaseId: null, folder: "e2e-bad" });
      const split = results[1];
      expect(split.passed).toBe(false);
      expect(split.failedStep).toBe(3);
      expect(split.problems.join("\n")).toMatch(/API returned a web page: Fetch \/api\/split\?amount=90&people=3/);
      expect(split.screenshots.at(-1)?.label).toBe("Failure");
      expect(results[2].passed).toBe(true);
      const report = failureReport(results, scenario, { how: "npm run dev", url: handle.url, appLog: "Ready" });
      expect(report).toContain("1 of 3 end-to-end test cases failed");
      expect(report).toContain('Failed at step 4: expect "Each pays 30.00"');
      expect(report).toContain("Unexpected response from the server");
    } finally {
      handle.stop();
    }
  }, 120_000);

  it.skipIf(!browser)("fails the run when test cases are deleted instead of fixed", async () => {
    const project = await createProject({ name: "shrink", engine: "fake" });
    write(project.path, { ...splitApp(false), [E2E_FILE]: JSON.stringify(SPLIT_CASES) });
    await git.commitAll(project.path, "app with two cases");
    const baseSha = await git.headSha(project.path);
    write(project.path, { [E2E_FILE]: JSON.stringify({ cases: [SPLIT_CASES.cases[1]] }) });
    const result = await runAcceptance({ projectPath: project.path, projectId: project.id, phaseId: 0, plan: { preview: null } as never, baseSha, folder: "shrink", onProgress: () => undefined });
    expect(result.outcome.passed).toBe(false);
    expect(result.outcome.output).toMatch(/had 2 test cases and now has 1/);
  }, 60_000);
});
