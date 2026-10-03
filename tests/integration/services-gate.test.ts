import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../../server/meadow/config";
import { getDb } from "../../server/meadow/core/db";
import { FakeEngine } from "../../server/meadow/engines/fake";
import { setEngine } from "../../server/meadow/engines/registry";
import { harness } from "../../server/meadow/harness/runner";
import { formatEvent } from "../../server/meadow/channels/notifier";
import { withServicesPhase } from "../../server/meadow/planning/format";
import { approvePlan, createProject, savePlanVersion } from "../../server/meadow/projects";
import { settled, tempHome, THREE_PHASE_PLAN } from "../helpers";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
  saveConfig({ harness: { e2e: false } });
});
afterEach(async () => {
  await harness.shutdown();
  delete process.env.MEADOW_CURSOR_BIN;
  env.cleanup();
});

function fakeCursor(status: string) {
  const bin = path.join(env.root, `agent-${status}`);
  fs.writeFileSync(bin, `#!/bin/sh\necho "supabase: ${status}"\n`, { mode: 0o755 });
  process.env.MEADOW_CURSOR_BIN = bin;
}

const SUPABASE_PLAN = withServicesPhase(THREE_PHASE_PLAN.replace("stack: [shell]", "stack: [shell]\nservices: [supabase]"));

describe("services gate before the first phase", () => {
  it("waits with a sign-in card when Supabase needs login, then builds without it when resumed", async () => {
    fakeCursor("requires_authentication");
    setEngine(new FakeEngine());
    const project = await createProject({ name: "needs-supabase", engine: "fake" });
    await approvePlan(savePlanVersion(project.id, SUPABASE_PLAN).id);
    const parked = settled(project.id);
    await harness.start(project.id);
    expect((await parked).payload?.status).toBe("waiting");
    const card = getDb().get<{ id: number; type: string; title: string; detail: string; payload_json: string }>("SELECT * FROM events WHERE project_id = ? AND type = 'setup' ORDER BY id DESC LIMIT 1", project.id)!;
    expect(card.title).toMatch(/supabase needs a one-time sign-in/);
    const outgoing = formatEvent({ id: card.id, projectId: project.id, executionId: null, runId: null, phaseId: null, ts: "", type: "setup", title: card.title, detail: card.detail, payload: JSON.parse(card.payload_json) });
    expect(outgoing?.buttons?.flat().map(button => button.callback_data)).toEqual(["svclogin:supabase", `resume:${project.id}`]);
    expect(getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM runs")!.n).toBe(0);

    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");
    const services = getDb().get<{ status: string }>("SELECT status FROM phases WHERE phase_key = 'services'")!;
    expect(services.status).toBe("skipped");
    const prompt = getDb().get<{ prompt: string }>("SELECT prompt FROM runs ORDER BY id LIMIT 1")!.prompt;
    expect(prompt).toMatch(/build without supabase/);
  }, 30_000);

  it("goes straight on when Supabase is ready", async () => {
    fakeCursor("ready");
    setEngine(new FakeEngine());
    const project = await createProject({ name: "has-supabase", engine: "fake" });
    await approvePlan(savePlanVersion(project.id, THREE_PHASE_PLAN.replace("stack: [shell]", "stack: [shell]\nservices: [supabase]")).id);
    const done = settled(project.id);
    await harness.start(project.id);
    expect((await done).payload?.status).toBe("completed");
    expect(getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'setup'")!.n).toBe(0);
  }, 30_000);
});
