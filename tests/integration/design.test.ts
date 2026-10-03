import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../helpers";

const { findBrowser } = await import("../../server/meadow/visual/browser");
const { DESIGN_CASE, failureReport, runEndToEnd } = await import("../../server/meadow/visual/e2e");
const { detectLaunch, launchApp } = await import("../../server/meadow/visual/launch");
const { createProject } = await import("../../server/meadow/projects");

let env: ReturnType<typeof tempHome>;
beforeEach(() => { env = tempHome(); });
afterEach(() => env.cleanup());

const BODY = `<header><h1>Habits</h1></header><main><label for="name">New habit</label><input id="name" placeholder="New habit"><button>Add</button><ul><li>Read</li></ul></main>`;
const VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1">`;
const PLAIN = `<!doctype html><html><head><title>Habits</title>${VIEWPORT}</head><body>${BODY}<div style="width:900px">wide row</div></body></html>`;
const rules = Array.from({ length: 30 }, (_, i) => `.u${i}{margin:${i}px}`).join("");
const STYLED = `<!doctype html><html><head><title>Habits</title>${VIEWPORT}<style>
:root{--bg:#FAF8F3;--surface:#F2EFE8;--text:#151515;--muted:#5E5A53;--border:#D8D3C9;--accent:#D97706}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:16px}
header{padding:24px;border-bottom:1px solid var(--border)}h1{font-size:48px;margin:0}main{max-width:720px;margin:0 auto;padding:24px;background:var(--surface)}
label{color:var(--muted)}input{border:1px solid var(--border);padding:10px;border-radius:4px;background:#fff}
button{border:0;background:var(--text);color:var(--bg);padding:10px 16px;border-radius:4px;transition:background .2s}
button:hover{background:var(--accent)}button:focus-visible,input:focus-visible{outline:2px solid var(--accent)}li{color:var(--accent)}${rules}
</style></head><body>${BODY}</body></html>`;

describe("the design check in the browser", async () => {
  const browser = process.env.MEADOW_TEST_BROWSER === "0" ? null : await findBrowser();

  it.skipIf(!browser)("sends browser-default pages back with every issue and passes a designed one", async () => {
    const project = await createProject({ name: "looks", engine: "fake" });
    const run = async (html: string, folder: string) => {
      fs.writeFileSync(path.join(project.path, "index.html"), html);
      const handle = await launchApp((await detectLaunch(project.path, null))!, project.path);
      try {
        return { results: await runEndToEnd({ browser: browser!, baseUrl: handle.url, cases: [], projectPath: project.path, projectId: project.id, phaseId: null, folder, design: true }), url: handle.url };
      } finally {
        handle.stop();
      }
    };

    const plain = await run(PLAIN, "plain");
    expect(plain.results.map(result => [result.name, result.passed])).toEqual([["The app loads without errors", false], [DESIGN_CASE, false]]);
    const desktop = plain.results[0].problems.join("\n");
    expect(desktop).toMatch(/Design: The text uses the browser's default font/);
    expect(desktop).toMatch(/unstyled browser defaults: "New habit", "Add"/);
    expect(desktop).toMatch(/Nothing reacts on hover/);
    expect(plain.results[1].problems.join("\n")).toMatch(/Design: The page scrolls sideways by \d+px on a 390px wide screen/);
    expect(failureReport(plain.results, [], { how: "open index.html", url: plain.url, appLog: "" })).toMatch(/Meet the design standard/);

    const zoomed = await run(PLAIN.replace(VIEWPORT, ""), "zoomed");
    expect(zoomed.results[1].problems.join("\n")).toMatch(/renders 980px wide and zoomed out/);

    const styled = await run(STYLED, "styled");
    expect(styled.results.map(result => [result.name, result.passed, result.failure])).toEqual([["The app loads without errors", true, null], [DESIGN_CASE, true, null]]);
  }, 90_000);
});
