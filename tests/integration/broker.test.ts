import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homePath, loadConfig, saveConfig } from "../../server/meadow/config";
import { decide } from "../../server/meadow/core/approvals";
import { getDb } from "../../server/meadow/core/db";
import { askHuman, executeReady, requestSystemAction } from "../../server/meadow/guard/broker";
import { addGrant, hasGrant } from "../../server/meadow/guard/grants";
import { handleAction, handleText } from "../../server/meadow/intake/conversation";
import { createProject } from "../../server/meadow/projects";
import { requestCloudResource } from "../../server/meadow/services/cloud";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
});
afterEach(() => env.cleanup());

type Pending = { id: number; kind: string; title: string };
async function pending(kind?: string): Promise<Pending> {
  for (let i = 0; i < 200; i++) {
    const row = getDb().get<Pending>(`SELECT id, kind, title FROM approvals WHERE status = 'pending'${kind ? " AND kind = ?" : ""} ORDER BY id DESC LIMIT 1`, ...(kind ? [kind] : []));
    if (row) return row;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("no pending approval appeared");
}

async function executeUntilDone<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.finally(() => (done = true));
  while (!done) {
    await executeReady();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return promise;
}

describe("ask_human", () => {
  it("returns the option the user tapped on Telegram", async () => {
    const project = await createProject({ name: "asks", engine: "fake" });
    const answer = askHuman({ projectId: project.id, question: "Which database?", options: ["Postgres", "SQLite"], pollMs: 10 });
    const row = await pending("question");
    expect((await handleAction("telegram", "1", `reply:${row.id}:1`, "telegram:1")).text).toContain("SQLite");
    expect(await answer).toMatchObject({ answered: true, answer: "SQLite" });
  });

  it("takes a typed Telegram message as the answer", async () => {
    const project = await createProject({ name: "typed", engine: "fake" });
    const answer = askHuman({ projectId: project.id, question: "What should the app be called?", pollMs: 10 });
    await pending("question");
    expect((await handleText("telegram", "1", "Splitwise Lite")).text).toContain("Sent your answer");
    expect(await answer).toMatchObject({ answered: true, answer: "Splitwise Lite" });
  });

  it("tells the engine to choose safely when the user declines or the question expires", async () => {
    const project = await createProject({ name: "declined", engine: "fake" });
    const declined = askHuman({ projectId: project.id, question: "Dark mode?", options: ["Yes", "No"], pollMs: 10 });
    decide((await pending("question")).id, "denied", "telegram");
    expect(await declined).toMatchObject({ answered: false, answer: null });
    saveConfig({ approvals: { expiryS: 0 } });
    const expired = await askHuman({ projectId: project.id, question: "Font?", pollMs: 10 });
    expect(expired.answered).toBe(false);
    expect(expired.note).toMatch(/safest/);
  });
});

describe("request_system_action", () => {
  it("refuses forbidden commands and leaves allowed ones to the engine", async () => {
    const project = await createProject({ name: "sys-policy", engine: "fake" });
    const refused = await requestSystemAction({ projectId: project.id, command: "sudo rm -rf /usr/local/lib", reason: "cleanup", pollMs: 10 });
    expect(refused).toMatchObject({ level: "forbidden", status: "refused" });
    expect(getDb().get<{ risk: string }>("SELECT risk FROM audit_log WHERE tool = 'broker.system.privilege'")?.risk).toBe("DESTRUCTIVE");
    const allowed = await requestSystemAction({ projectId: project.id, command: "pnpm test", reason: "tests", pollMs: 10 });
    expect(allowed.output).toMatch(/Run it yourself/);
    expect(getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals")?.n).toBe(0);
  });

  it("does not run a command the user denied", async () => {
    const project = await createProject({ name: "sys-denied", engine: "fake" });
    const result = requestSystemAction({ projectId: project.id, command: "git push origin main", reason: "publish", pollMs: 10 });
    decide((await pending("system.git-push")).id, "denied", "telegram");
    expect(await executeUntilDone(result)).toMatchObject({ status: "denied", exitCode: null });
    expect(fs.readdirSync(homePath("broker"))).toEqual([]);
  });

  it("runs an approved command outside the engine and returns its output", async () => {
    const project = await createProject({ name: "sys-approved", engine: "fake" });
    const result = requestSystemAction({ projectId: project.id, command: "git push origin main", reason: "publish", pollMs: 10 });
    decide((await pending("system.git-push")).id, "approved", "telegram");
    const done = await executeUntilDone(result);
    expect(done.status).toBe("failed");
    expect(done.exitCode).not.toBe(0);
    expect(done.output).toMatch(/origin/);
    const row = getDb().get<{ approval: string; result: string }>("SELECT approval, result FROM audit_log WHERE tool = 'broker.system.git-push'");
    expect(row).toEqual({ approval: "approved", result: "error" });
  });

  it("remembers 'always for this project' and skips the approval next time", async () => {
    const project = await createProject({ name: "sys-always", engine: "fake" });
    const first = requestSystemAction({ projectId: project.id, command: "git push origin main", reason: "publish", pollMs: 10 });
    const row = await pending("system.git-push");
    await handleAction("telegram", "1", `approval:${row.id}:always`, "telegram:1");
    expect(hasGrant(project.id, "system.git-push")).toBe(true);
    await executeUntilDone(first);
    const before = getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals")!.n;
    await executeUntilDone(requestSystemAction({ projectId: project.id, command: "git push origin feature", reason: "publish", pollMs: 10 }));
    expect(getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals")!.n).toBe(before);
    expect(() => addGrant(project.id, "cloud.supabase")).toThrow();
  });

  it("re-checks the policy before executing, even for a tampered request file", async () => {
    const project = await createProject({ name: "sys-tamper", engine: "fake" });
    addGrant(project.id, "system.git-push");
    const result = requestSystemAction({ projectId: project.id, command: "git push origin main", reason: "publish", pollMs: 10 });
    let file = "";
    for (let i = 0; i < 100 && !file; i++) {
      file = fs.existsSync(homePath("broker")) ? fs.readdirSync(homePath("broker")).find(name => name.endsWith(".request.json")) ?? "" : "";
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const request = JSON.parse(fs.readFileSync(homePath("broker", file), "utf8"));
    fs.writeFileSync(homePath("broker", file), JSON.stringify({ ...request, command: "sudo shutdown -h now" }));
    expect(await executeUntilDone(result)).toMatchObject({ status: "refused" });
  });
});

describe("request_cloud_resource", () => {
  const orgs = [{ id: "org-a", name: "Personal", plan: "free" }, { id: "org-b", name: "Work", plan: "pro" }];

  it("asks for the Supabase organisation once and remembers it", async () => {
    const project = await createProject({ name: "cloud-org", engine: "fake" });
    const reply = requestCloudResource({ projectId: project.id, service: "supabase", action: "create_or_reuse_project", details: { organizations: orgs, projects: [], cost: { amount: 0 } }, pollMs: 10 });
    const row = await pending("question");
    await handleAction("telegram", "1", `reply:${row.id}:0`, "telegram:1");
    const done = await reply;
    expect(done.decision).toMatchObject({ action: "create", orgId: "org-a", requiresApproval: false });
    expect(done.message).toMatch(/create_project/);
    expect(loadConfig().services.supabase).toEqual({ orgId: "org-a", orgName: "Personal" });
    const again = await requestCloudResource({ projectId: project.id, service: "supabase", action: "create_or_reuse_project", details: { organizations: orgs, projects: [], cost: { amount: 0 } }, pollMs: 10 });
    expect(again.decision).toMatchObject({ action: "create", orgId: "org-a" });
    expect(getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals")!.n).toBe(1);
  });

  it("needs approval for a paid project and refuses when denied", async () => {
    const project = await createProject({ name: "cloud-paid", engine: "fake" });
    saveConfig({ services: { supabase: { orgId: "org-b", orgName: "Work" } } });
    const reply = requestCloudResource({ projectId: project.id, service: "supabase", action: "create_or_reuse_project", details: { organizations: orgs, projects: [], cost: { amount: 10, recurrence: "monthly" } }, pollMs: 10 });
    decide((await pending("cloud.supabase")).id, "denied", "telegram");
    expect(await reply).toMatchObject({ ok: false });
    expect(getDb().get<{ approval: string }>("SELECT approval FROM audit_log WHERE tool = 'broker.cloud.supabase.create_project'")?.approval).toBe("denied");
  });

  it("rejects malformed facts and unknown services", async () => {
    const project = await createProject({ name: "cloud-bad", engine: "fake" });
    expect((await requestCloudResource({ projectId: project.id, service: "supabase", action: "create_or_reuse_project", details: { organizations: "lots" } })).message).toMatch(/list_organizations/);
    expect((await requestCloudResource({ projectId: project.id, service: "aws", action: "create_bucket" })).message).toMatch(/ask_human/);
  });
});
