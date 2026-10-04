import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../../server/meadow/config";
import { getDb } from "../../server/meadow/core/db";
import { FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { ENV_SKIPPED_NOTE, harness } from "../../server/meadow/harness/runner";
import { formatEvent } from "../../server/meadow/channels/notifier";
import { approvePlan, createProject, savePlanVersion } from "../../server/meadow/projects";
import { settled, tempHome, THREE_PHASE_PLAN } from "../helpers";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
  saveConfig({ harness: { e2e: false } });
});
afterEach(async () => {
  await harness.shutdown();
  env.cleanup();
});

const ENV_PLAN = THREE_PHASE_PLAN.replace("stack: [shell]", 'stack: [shell]\nenv:\n  required:\n    - FREELLM_API_KEY: "freellmapi.com dashboard"');

describe("environment gate before the first phase", () => {
  it("writes placeholders, waits with a card, and continues once the value is filled in", async () => {
    setEngine(new FakeEngine());
    const project = await createProject({ name: "needs-key", engine: "fake" });
    await approvePlan(savePlanVersion(project.id, ENV_PLAN).id);
    const parked = settled(project.id);
    await harness.start(project.id);
    expect((await parked).payload?.status).toBe("waiting");
    expect(getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM runs")!.n).toBe(0);

    const localFile = path.join(project.path, ".env.local");
    expect(fs.readFileSync(localFile, "utf8")).toMatch(/^FREELLM_API_KEY=$/m);
    expect(fs.readFileSync(path.join(project.path, ".env.example"), "utf8")).toContain("FREELLM_API_KEY=");
    expect(fs.readFileSync(path.join(project.path, ".gitignore"), "utf8")).toContain("!.env.example");

    const card = getDb().get<{ id: number; title: string; detail: string; payload_json: string }>("SELECT * FROM events WHERE project_id = ? AND type = 'setup' ORDER BY id DESC LIMIT 1", project.id)!;
    expect(card.title).toBe("1 environment variable needed");
    const outgoing = formatEvent({ id: card.id, projectId: project.id, executionId: null, runId: null, phaseId: null, ts: "", type: "setup", title: card.title, detail: card.detail, payload: JSON.parse(card.payload_json) });
    expect(outgoing?.buttons?.flat().map(button => button.callback_data)).toEqual([`resume:${project.id}`, `envskip:${project.id}`]);

    fs.writeFileSync(localFile, fs.readFileSync(localFile, "utf8").replace("FREELLM_API_KEY=", "FREELLM_API_KEY=sk-test-value"));
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");
    const prompt = getDb().get<{ prompt: string }>("SELECT prompt FROM runs ORDER BY id LIMIT 1")!.prompt;
    expect(prompt).toContain("FREELLM_API_KEY");
    expect(prompt).not.toContain("sk-test-value");
    expect(getDb().all<{ detail: string }>("SELECT detail FROM events").some(row => row.detail.includes("sk-test-value"))).toBe(false);
  }, 30_000);

  it("builds without the value when the user chooses to", async () => {
    setEngine(new FakeEngine());
    const project = await createProject({ name: "skip-key", engine: "fake" });
    await approvePlan(savePlanVersion(project.id, ENV_PLAN).id);
    const parked = settled(project.id);
    await harness.start(project.id);
    expect((await parked).payload?.status).toBe("waiting");
    getDb().update("executions", harness.latestExecution(project.id)!.id, { note: ENV_SKIPPED_NOTE });
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");
    const prompt = getDb().get<{ prompt: string }>("SELECT prompt FROM runs ORDER BY id LIMIT 1")!.prompt;
    expect(prompt).toMatch(/still empty in \.env\.local: FREELLM_API_KEY/);
  }, 30_000);
});
