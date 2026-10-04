import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../helpers";

const { findBrowser } = await import("../../server/meadow/visual/browser");
const { detectLaunch, launchApp } = await import("../../server/meadow/visual/launch");
const { runCheck } = await import("../../server/meadow/harness/verifier");
const { createProject } = await import("../../server/meadow/projects");

let env: ReturnType<typeof tempHome>;
beforeEach(() => { env = tempHome(); });
afterEach(() => env.cleanup());

const PAGE = `<!doctype html><html><head><title>Counter</title></head><body>
<button id="add">Add one</button><p id="count">Count: 0</p>
<script>let n=0;document.getElementById("add").onclick=()=>{n++;document.getElementById("count").textContent="Count: "+n;};</script>
</body></html>`;

describe("e2e checks inside a phase", async () => {
  const browser = process.env.MEADOW_TEST_BROWSER === "0" ? null : await findBrowser();

  it("fails without a preview", async () => {
    const project = await createProject({ name: "no-preview", engine: "fake" });
    const outcome = await runCheck({ kind: "e2e", path: "/" }, project.path, null);
    expect(outcome.passed).toBe(false);
    expect(outcome.output).toMatch(/need a running preview/);
  });

  it.skipIf(!browser)("asks for cases when there are none, then runs the route's cases in a real browser", async () => {
    const project = await createProject({ name: "counter", engine: "fake" });
    fs.writeFileSync(path.join(project.path, "index.html"), PAGE);
    const handle = await launchApp((await detectLaunch(project.path, null))!, project.path);
    try {
      const missing = await runCheck({ kind: "e2e", path: "/" }, project.path, handle.url, undefined, { projectId: project.id, phaseId: null });
      expect(missing.passed).toBe(false);
      expect(missing.output).toMatch(/meadow\.e2e\.json/);

      const write = (expect: string) => fs.writeFileSync(path.join(project.path, "meadow.e2e.json"), JSON.stringify({ cases: [{ name: "Counting up", path: "/", steps: [{ click: "Add one" }, { click: "Add one" }, { expect }] }] }));
      write("Count: 2");
      const ok = await runCheck({ kind: "e2e", path: "/" }, project.path, handle.url, undefined, { projectId: project.id, phaseId: null });
      expect(ok.output).toMatch(/(\d+)\/\1 browser test cases passed on \//);
      expect(ok.passed).toBe(true);

      write("Count: 3");
      const bad = await runCheck({ kind: "e2e", path: "/" }, project.path, handle.url, undefined, { projectId: project.id, phaseId: null });
      expect(bad.passed).toBe(false);
      expect(bad.output).toMatch(/Counting up/);
    } finally {
      handle.stop();
    }
  }, 90_000);
});
