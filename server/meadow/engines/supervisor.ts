import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { homePath } from "../config";
import { killTree, spawnGroup } from "../core/exec";
import { EventQueue, type EngineEvent, type RunRequest } from "./base";

export type LineParser = (line: string) => EngineEvent[];

/**
 * Runs an engine CLI in its own process group with a total timeout and a no-output watchdog,
 * logs raw stdout/stderr to ~/.meadow/logs/runs/<runId>.{out,err}, and turns stdout lines into events.
 */
export class Supervisor {
  private children = new Map<string, ChildProcess>();
  private cancelled = new Set<string>();

  start(req: RunRequest, command: string, args: string[], parse: LineParser): AsyncIterable<EngineEvent> {
    const queue = new EventQueue<EngineEvent>();
    const logDir = homePath("logs", "runs");
    fs.mkdirSync(logDir, { recursive: true });
    const outLog = fs.createWriteStream(path.join(logDir, `${req.runId}.out`));
    const errLog = fs.createWriteStream(path.join(logDir, `${req.runId}.err`));

    let child: ChildProcess;
    try {
      child = spawnGroup(command, args, { cwd: req.cwd, env: req.env });
    } catch (error) {
      queue.push({ type: "error", title: "Engine failed to start", detail: (error as Error).message, reason: "crashed" });
      queue.push({ type: "done", title: "Engine failed to start", ok: false, reason: "crashed" });
      queue.close();
      return queue;
    }
    this.children.set(req.runId, child);

    let endReason: string | null = null;
    let sawDone = false;
    let buffer = "";
    let stderrTail = "";

    const total = setTimeout(() => {
      endReason = "timeout";
      killTree(child);
    }, req.timeoutS * 1000);
    let silence: NodeJS.Timeout;
    const armSilence = () => {
      clearTimeout(silence);
      silence = setTimeout(() => {
        endReason = "no_output";
        killTree(child);
      }, req.noOutputTimeoutS * 1000);
    };
    armSilence();

    const emitLine = (line: string) => {
      if (!line.trim()) return;
      let events: EngineEvent[] = [];
      try {
        events = parse(line);
      } catch {
        events = [];
      }
      for (const event of events) {
        if (event.type === "done") sawDone = true;
        queue.push(event);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      armSilence();
      outLog.write(chunk);
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        emitLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      armSilence();
      errLog.write(chunk);
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    child.on("error", error => {
      endReason = endReason ?? "crashed";
      stderrTail += `\n${error.message}`;
    });
    child.on("close", code => {
      clearTimeout(total);
      clearTimeout(silence);
      if (buffer) emitLine(buffer);
      outLog.end();
      errLog.end();
      this.children.delete(req.runId);
      if (this.cancelled.delete(req.runId)) endReason = "cancelled";
      if (endReason) {
        const messages: Record<string, string> = {
          timeout: `Engine exceeded the total run timeout (${req.timeoutS}s) and was stopped.`,
          no_output: `Engine produced no output for ${req.noOutputTimeoutS}s and was stopped (silent hang).`,
          cancelled: "Run was cancelled.",
          crashed: `Engine process failed: ${stderrTail.trim().slice(-500)}`,
        };
        queue.push({ type: "error", title: messages[endReason] ?? endReason, detail: stderrTail.trim().slice(-1500), reason: endReason });
        queue.push({ type: "done", title: "Engine stopped", ok: false, reason: endReason });
      } else if (!sawDone) {
        const ok = code === 0;
        if (!ok) queue.push({ type: "error", title: `Engine exited with code ${code}`, detail: stderrTail.trim().slice(-1500), reason: /not logged in|log ?in required|please log ?in|logged out|unauthenticated|unauthori[sz]ed|invalid api key|authentication/i.test(stderrTail) ? "auth" : "crashed" });
        queue.push({ type: "done", title: ok ? "Engine finished" : "Engine failed", ok, reason: ok ? "completed" : "crashed" });
      }
      queue.close();
    });
    return queue;
  }

  async cancel(runId: string) {
    const child = this.children.get(runId);
    if (!child) return;
    this.cancelled.add(runId);
    killTree(child);
  }

  activeCount() {
    return this.children.size;
  }
}
