import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemp } from "../helpers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-showcase-"));
process.env.MEADOW_HOME = path.join(dir, "home");
process.env.MEADOW_PROJECTS_DIR = path.join(dir, "projects");
process.env.MEADOW_NO_JSONL = "1";
delete process.env.MEADOW_ENGINE;
afterAll(() => removeTemp(dir));

const { detectLaunch, launchApp, printedUrls, serveStatic } = await import("../../server/meadow/visual/launch");
const { findBrowser } = await import("../../server/meadow/visual/browser");
const { captureRoutes } = await import("../../server/meadow/visual/capture");
const { formatEvent, wantsEvent } = await import("../../server/meadow/channels/notifier");
const { createProject, planOrigin, savePlanVersion } = await import("../../server/meadow/projects");
const { bus } = await import("../../server/meadow/core/events");
const { getDb } = await import("../../server/meadow/core/db");

const make = (name: string, files: Record<string, string>) => {
  const root = path.join(dir, name);
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  return root;
};

describe("working out how to run any project", () => {
  it("uses the plan's preview block first", async () => {
    const spec = await detectLaunch(dir, { preview: { command: "npm run dev", url: "http://localhost:3000", readyTimeoutS: 30, routes: ["/", "/about"] } } as never);
    expect(spec).toMatchObject({ kind: "plan", how: "npm run dev", routes: ["/", "/about"] });
  });

  it("picks the dev script and the project's package manager", async () => {
    const root = make("vite-app", { "package.json": JSON.stringify({ scripts: { build: "vite build", dev: "vite" } }), "package-lock.json": "{}" });
    const spec = await detectLaunch(root, null);
    expect(spec?.kind).toBe("command");
    if (spec?.kind !== "command") return;
    expect(spec.how).toBe("npm run dev");
    expect(spec.install).toBe("npm install");
    expect(spec.port).toBeGreaterThan(0);
  });

  it("looks in a client folder when the root has no scripts", async () => {
    const root = make("split-app", { "client/package.json": JSON.stringify({ scripts: { start: "node server.js" } }) });
    const spec = await detectLaunch(root, null);
    expect(spec?.how).toMatch(/^cd client && \w+ run start$/);
  });

  it("recognises Python web apps", async () => {
    const root = make("py-app", { "main.py": "from fastapi import FastAPI\napi = FastAPI()\n" });
    const spec = await detectLaunch(root, null);
    if (!spec) return; // no Python on this machine
    expect(spec.kind).toBe("command");
    if (spec.kind === "command") expect(spec.command).toMatch(/-m uvicorn main:api --host 127\.0\.0\.1 --port \d+/);
  });

  it("falls back to a built index.html and returns null for libraries", async () => {
    expect(await detectLaunch(make("static", { "dist/index.html": "<h1>hi</h1>" }), null)).toMatchObject({ kind: "static" });
    expect(await detectLaunch(make("lib", { "src/index.ts": "export const x = 1;" }), null)).toBeNull();
  });

  it("reads the URL a dev server prints, including 0.0.0.0 and colours", () => {
    expect(printedUrls("\x1b[32m  ➜  Local:   http://localhost:5173/\x1b[0m\n  Network: http://192.168.1.4:5173/")).toEqual(["http://localhost:5173/"]);
    expect(printedUrls("Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)")).toEqual(["http://127.0.0.1:8000"]);
  });
});

describe("serving and starting the app", () => {
  it("serves a static folder on loopback without escaping it", async () => {
    const root = make("site", { "index.html": "<h1>Home</h1>", "app.js": "1" });
    const handle = await serveStatic(root);
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(await (await fetch(handle.url)).text()).toContain("Home");
      expect(await (await fetch(new URL("/deep/route", handle.url))).text()).toContain("Home");
      expect((await fetch(new URL("/..%2f..%2fetc/passwd", handle.url))).status).not.toBe(200);
    } finally {
      handle.stop();
    }
  });

  it("starts a command, finds its printed URL and stops it", async () => {
    const root = make("node-app", { "server.js": `require("http").createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<p>ok</p>"); }).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("Ready on http://localhost:" + process.env.PORT));` });
    const handle = await launchApp({ kind: "command", how: "node server.js", routes: ["/"], command: "node server.js", install: null, port: await (await import("../../server/meadow/visual/launch")).freePort(), readyTimeoutS: 20 }, root);
    try {
      expect(await (await fetch(handle.url)).text()).toContain("ok");
    } finally {
      handle.stop();
    }
  });
});

describe("headless screenshots with the browser already on this machine", async () => {
  const browser = process.env.MEADOW_TEST_BROWSER === "0" ? null : await findBrowser();
  it.skipIf(!browser)("captures desktop and mobile shots of a local page", async () => {
    const project = await createProject({ name: "shots", engine: "fake" });
    fs.writeFileSync(path.join(project.path, "index.html"), "<h1 style='color:green'>Expense app</h1>");
    const handle = await serveStatic(project.path);
    try {
      const { shots, skipped } = await captureRoutes({ baseUrl: handle.url, routes: ["/"], projectPath: project.path, projectId: project.id, phaseId: null, folder: "final-test" });
      expect(skipped).toEqual([]);
      expect(shots.map(shot => shot.viewport)).toEqual(["desktop", "mobile"]);
      for (const shot of shots) expect(fs.statSync(shot.path).size).toBeGreaterThan(1000);
    } finally {
      handle.stop();
    }
  }, 120_000);
});

describe("Telegram reports", () => {
  const base = { id: 1, executionId: 1, runId: null, phaseId: null, ts: new Date().toISOString(), detail: "" };

  it("sends a review card for every new draft plan, except back to the Telegram chat that asked for it", async () => {
    const project = await createProject({ name: "review", engine: "fake" });
    const plan = "---\nproject: review\ngoal: Test\nphases:\n  - id: p1\n    name: One\n    tasks: [Do it]\n    checks:\n      - cmd: node -e 1\n    done_when: done\n---\n";
    const seen: Array<Record<string, unknown>> = [];
    const off = bus.onEvent(event => event.type === "plan_ready" && seen.push({ ...event.payload, title: event.title, detail: event.detail }));
    savePlanVersion(project.id, plan);
    await planOrigin.run({ channel: "telegram" }, async () => savePlanVersion(project.id, plan));
    off();
    expect(seen.map(item => item.channel)).toEqual([null, "telegram"]);
    const card = formatEvent({ ...base, projectId: project.id, type: "plan_ready", title: String(seen[0].title), detail: String(seen[0].detail), payload: seen[0] });
    expect(card?.text).toContain("1. One (1 check)");
    expect(card?.buttons?.[0][0].callback_data).toMatch(/^approve:\d+$/);
    expect(formatEvent({ ...base, projectId: project.id, type: "plan_ready", title: "x", detail: "", payload: seen[1] })).toBeNull();
    expect(wantsEvent({ ...base, projectId: project.id, type: "plan_ready", title: "x", detail: "", payload: { status: "draft", planId: 1 } })).toBe(true);
  });

  it("attaches the final screenshots and how to run the app when a run completes", async () => {
    const project = await createProject({ name: "done-app", engine: "fake" });
    const file = path.join(project.path, "shot.png");
    fs.writeFileSync(file, "png");
    const id = getDb().insert("screenshots", { phase_id: null, project_id: project.id, label: "/ · desktop", path: file, viewport: "1280x800", ts: new Date().toISOString() });
    const card = formatEvent({ ...base, projectId: project.id, type: "execution_finished", title: "All phases passed", payload: { status: "completed", screenshotIds: [id], runHow: "pnpm run dev" } });
    expect(card?.text).toContain(`cd ${project.path}\npnpm run dev`);
    expect(card?.photos).toEqual([{ path: file, caption: "Finished app · / · desktop" }]);
    expect(card?.buttons?.[0].map(button => button.callback_data)).toContain(`shot:${project.id}`);
  });
});
