import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTemp } from "../helpers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-self-guard-"));
process.env.MEADOW_HOME = path.join(dir, "home");
process.env.MEADOW_PROJECTS_DIR = path.join(dir, "projects");
process.env.MEADOW_NO_JSONL = "1";
delete process.env.MEADOW_ENGINE;
afterAll(() => removeTemp(dir));

const { isMeadowSource, overlapsMeadow } = await import("../../server/meadow/core/self");
const { createProject } = await import("../../server/meadow/projects");
const { formatLiveLine, liveLogPath } = await import("../../server/meadow/harness/watch");

const fakeMeadow = path.join(dir, "meadow-src");
fs.mkdirSync(path.join(fakeMeadow, "server", "meadow", "harness"), { recursive: true });
fs.writeFileSync(path.join(fakeMeadow, "package.json"), JSON.stringify({ name: "meadow" }));

describe("Meadow never works on its own source", () => {
  it("recognises a Meadow checkout but not other apps called meadow", () => {
    expect(isMeadowSource(fakeMeadow)).toBe(true);
    const lookalike = path.join(dir, "other");
    fs.mkdirSync(lookalike, { recursive: true });
    fs.writeFileSync(path.join(lookalike, "package.json"), JSON.stringify({ name: "meadow" }));
    expect(isMeadowSource(lookalike)).toBe(false);
  });

  it("flags the folder itself, folders inside it and the folder it runs from", () => {
    expect(overlapsMeadow(fakeMeadow)).toBe(fakeMeadow);
    expect(overlapsMeadow(path.join(fakeMeadow, "apps", "web"))).toBe(fakeMeadow);
    expect(overlapsMeadow(path.join(dir, "projects", "expense-app"))).toBeNull();
    expect(overlapsMeadow(process.cwd())).not.toBeNull();
  });

  it("refuses to register Meadow as a project", async () => {
    await expect(createProject({ name: "meadow", engine: "fake", path: fakeMeadow })).rejects.toThrow(/Meadow's own folder/);
    const ok = await createProject({ name: "expense-app", engine: "fake" });
    expect(ok.path).toBe(path.join(dir, "projects", "expense-app"));
  });
});

describe("live log", () => {
  it("writes one readable line per engine event and skips noise", () => {
    const base = { id: 1, projectId: 1, executionId: 1, runId: 1, phaseId: 1, ts: new Date().toISOString(), detail: "" };
    expect(formatLiveLine({ ...base, type: "file_edit", title: "Edited src/app.ts", detail: "+12 −3\nmore" })).toMatch(/EDIT\s+Edited src\/app\.ts {2}· \+12 −3\n$/);
    expect(formatLiveLine({ ...base, type: "phase_started", title: "Phase p1 started" })).toContain("─".repeat(10));
    expect(formatLiveLine({ ...base, type: "usage", title: "tokens" })).toBeNull();
    expect(liveLogPath({ name: "expense-app" })).toBe(path.join(dir, "home", "logs", "live", "expense-app.log"));
  });
});
