import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EngineEvent } from "../../server/meadow/engines/base";
import { Supervisor } from "../../server/meadow/engines/supervisor";
import { minimalEnv } from "../../server/meadow/core/exec";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-sup-"));
process.env.MEADOW_HOME = path.join(dir, "home");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function collect(stream: AsyncIterable<EngineEvent>) {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const req = (runId: string, overrides: Partial<{ timeoutS: number; noOutputTimeoutS: number }> = {}) => ({ runId, prompt: "", cwd: dir, readonly: false, timeoutS: 30, noOutputTimeoutS: 30, env: minimalEnv(), model: null, ...overrides });

describe.skipIf(process.platform === "win32")("process supervisor", () => {
  it("kills a silent engine and its grandchildren (no orphans)", async () => {
    const pidFile = path.join(dir, "grandchild.pid");
    const supervisor = new Supervisor();
    const events = await collect(supervisor.start(req("hang", { noOutputTimeoutS: 1 }), "sh", ["-c", `sleep 300 & echo $! > ${pidFile}; echo started; sleep 300`], () => []));
    expect(events.at(-1)).toMatchObject({ type: "done", ok: false, reason: "no_output" });
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(alive(grandchild)).toBe(false);
  });

  it("enforces the total timeout even when output keeps flowing", async () => {
    const supervisor = new Supervisor();
    const events = await collect(supervisor.start(req("chatty", { timeoutS: 1, noOutputTimeoutS: 10 }), "sh", ["-c", "while true; do echo tick; sleep 0.1; done"], () => []));
    expect(events.at(-1)).toMatchObject({ reason: "timeout" });
  });

  it("cancels on request", async () => {
    const supervisor = new Supervisor();
    const stream = supervisor.start(req("cancel"), "sh", ["-c", "sleep 300"], () => []);
    setTimeout(() => void supervisor.cancel("cancel"), 200);
    const events = await collect(stream);
    expect(events.at(-1)).toMatchObject({ reason: "cancelled" });
    expect(supervisor.activeCount()).toBe(0);
  });

  it("reports a non-zero exit without a done line as a failure", async () => {
    const supervisor = new Supervisor();
    const events = await collect(supervisor.start(req("exit"), "sh", ["-c", "echo 'not logged in' >&2; exit 3"], () => []));
    expect(events.find(event => event.type === "error")?.reason).toBe("auth");
    expect(events.at(-1)).toMatchObject({ type: "done", ok: false });
  });

  it("parses stdout lines into events", async () => {
    const supervisor = new Supervisor();
    const events = await collect(supervisor.start(req("parse"), "sh", ["-c", "printf 'a\\nb\\n'"], line => [{ type: "message", title: line }]));
    expect(events.filter(event => event.type === "message").map(event => event.title)).toEqual(["a", "b"]);
  });

  it("does not leak the parent environment", () => {
    process.env.SUPER_SECRET_TOKEN = "x";
    expect(minimalEnv()).not.toHaveProperty("SUPER_SECRET_TOKEN");
    delete process.env.SUPER_SECRET_TOKEN;
  });
});
