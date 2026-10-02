import { afterEach, beforeEach, expect, it } from "vitest";
import { startActionExecutor } from "../../server/meadow/atlas/tools";
import { decide, requestApproval, sweepExpiredApprovals } from "../../server/meadow/core/approvals";
import { getDb, now } from "../../server/meadow/core/db";
import { bus, startForeignEventRelay } from "../../server/meadow/core/events";
import { createProject } from "../../server/meadow/projects";
import { tempHome, waitForEvent } from "../helpers";

let env: ReturnType<typeof tempHome>;
let stop: () => void;

beforeEach(() => {
  env = tempHome();
  stop = startForeignEventRelay(50);
});

afterEach(() => {
  stop();
  env.cleanup();
});

it("replays events written by another process onto the bus", async () => {
  const seen = waitForEvent(event => event.title === "from the MCP process", 2000);
  getDb().insert("events", { project_id: null, ts: now(), type: "approval_requested", title: "from the MCP process", detail: "", payload_json: JSON.stringify({ approvalId: 99 }) });
  const event = await seen;
  expect(event.payload?.approvalId).toBe(99);
  let local = 0;
  const off = bus.onEvent(e => e.title === "local" && local++);
  bus.emitEvent({ type: "message", title: "local", detail: "" });
  await new Promise(resolve => setTimeout(resolve, 150));
  off();
  expect(local).toBe(1);
});

it("executes an approved action requested by the MCP process", async () => {
  startActionExecutor();
  const project = await createProject({ name: "relay-demo", engine: "fake" });
  const approval = requestApproval({ projectId: project.id, kind: "atlas.create_issue", title: "Create issue: x", detail: "", detached: true });
  const actionId = getDb().insert("atlas_actions", { project_id: project.id, tool: "create_issue", title: "Create issue: x", args_json: JSON.stringify({ title: "Cap retries", body: "INC-2041 follow-up" }), status: "pending", approval_id: approval.id, actor: "mcp", created_at: now() });
  const done = waitForEvent(event => event.payload?.atlasAction === actionId, 2000);
  decide(approval.id, "approved", "telegram");
  await done;
  expect(getDb().get<{ status: string }>("SELECT status FROM atlas_actions WHERE id = ?", actionId)!.status).toBe("done");
  expect(getDb().get<{ title: string }>("SELECT title FROM notes WHERE source = 'atlas'")!.title).toBe("Cap retries");
});

it("expires detached approvals and their actions", async () => {
  startActionExecutor();
  const project = await createProject({ name: "relay-expiry", engine: "fake" });
  const approval = requestApproval({ projectId: project.id, kind: "atlas.run_tests", title: "Run tests", detail: "", detached: true, expiryS: -1 });
  const actionId = getDb().insert("atlas_actions", { project_id: project.id, tool: "run_tests", title: "Run tests", args_json: JSON.stringify({ command: "true" }), status: "pending", approval_id: approval.id, actor: "mcp", created_at: now() });
  expect(sweepExpiredApprovals()).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(getDb().get<{ status: string }>("SELECT status FROM atlas_actions WHERE id = ?", actionId)!.status).toBe("expired");
});
