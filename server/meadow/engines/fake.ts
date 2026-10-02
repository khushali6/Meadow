import fs from "node:fs";
import path from "node:path";
import { confine } from "../core/paths";
import type { DoctorReport, Engine, EngineEvent, RunRequest } from "./base";
import { parseCursorLine } from "./cursor";

export type FakeStep =
  | { event: EngineEvent; delayMs?: number }
  | { write: { path: string; content: string }; delayMs?: number }
  | { remove: string; delayMs?: number }
  | { hang: true };

export type FakeScript = (req: RunRequest, call: number) => FakeStep[];

/** Default behaviour: satisfy `file_exists` checks mentioned in the prompt and leave a note file. */
export const defaultFakeScript: FakeScript = (req, call) => {
  const files = Array.from(req.prompt.matchAll(/file exists: ([^\s`]+)/g)).map(match => match[1].replace(/[.,;:)]+$/, ""));
  const phase = req.prompt.match(/# This phase: (.+)/)?.[1]?.trim() ?? "phase";
  const steps: FakeStep[] = [
    { event: { type: "session_started", title: "Fake engine session started", sessionId: `fake-${req.runId}` } },
    { event: { type: "thinking", title: `Planning ${phase}` }, delayMs: 30 },
  ];
  for (const file of files) steps.push({ write: { path: file, content: `// created by the fake engine for ${phase}\n` }, delayMs: 20 });
  steps.push({ write: { path: `notes/${phase.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`, content: `# ${phase}\n\nAttempt ${call + 1}\n` }, delayMs: 20 });
  steps.push({ event: { type: "usage", title: "Token usage", usage: { tokensIn: 1200, tokensOut: 300 } } });
  steps.push({ event: { type: "done", title: "Fake engine finished", ok: true, reason: "completed", detail: `Files changed: ${files.length + 1}` } });
  return steps;
};

/** Replay a recorded cursor-agent stream-json session through the real parser. */
export function fixtureScript(fixtureFile: string): FakeScript {
  return () => fs.readFileSync(fixtureFile, "utf8").split("\n").filter(Boolean).flatMap(line => parseCursorLine(line).map(event => ({ event }) as FakeStep));
}

export class FakeEngine implements Engine {
  readonly name = "fake";
  readonly label = "Fake engine (demo/testing)";
  readonly supportsResume = false;
  private calls = 0;
  private cancelled = new Set<string>();
  readonly prompts: RunRequest[] = [];

  constructor(private script: FakeScript = defaultFakeScript) {}

  setScript(script: FakeScript) {
    this.script = script;
    this.calls = 0;
  }

  async doctor(): Promise<DoctorReport> {
    return { engine: this.name, ready: true, version: "1.0", checks: [{ name: "binary", ok: true, detail: "built in" }], flags: {} };
  }

  async *run(req: RunRequest): AsyncIterable<EngineEvent> {
    this.prompts.push(req);
    const steps = this.script(req, this.calls++);
    const started = Date.now();
    for (const step of steps) {
      if (this.cancelled.delete(req.runId)) {
        yield { type: "done", title: "Run was cancelled", ok: false, reason: "cancelled" };
        return;
      }
      if ("hang" in step) {
        while (!this.cancelled.has(req.runId)) {
          if (Date.now() - started > req.noOutputTimeoutS * 1000) {
            yield { type: "error", title: `Engine produced no output for ${req.noOutputTimeoutS}s and was stopped (silent hang).`, reason: "no_output" };
            yield { type: "done", title: "Engine stopped", ok: false, reason: "no_output" };
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        this.cancelled.delete(req.runId);
        yield { type: "done", title: "Run was cancelled", ok: false, reason: "cancelled" };
        return;
      }
      if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
      if ("write" in step) {
        const target = confine(req.cwd, step.write.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, step.write.content);
        yield { type: "file_edit", title: `Edited ${step.write.path}` };
      } else if ("remove" in step) {
        fs.rmSync(confine(req.cwd, step.remove), { force: true, recursive: true });
        yield { type: "file_edit", title: `Deleted ${step.remove}` };
      } else {
        yield step.event;
      }
    }
  }

  async cancel(runId: string) {
    this.cancelled.add(runId);
  }
}
