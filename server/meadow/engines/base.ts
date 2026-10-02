export type EngineEventType = "session_started" | "thinking" | "message" | "tool_call" | "file_edit" | "command_run" | "usage" | "error" | "done";

export type EngineEvent = {
  type: EngineEventType;
  title: string;
  detail?: string;
  sessionId?: string;
  usage?: { tokensIn: number; tokensOut: number; costUsd?: number };
  /** On `done`: whether the engine reported success. */
  ok?: boolean;
  /** On `done`/`error`: why the run ended (completed, timeout, no_output, cancelled, crashed, auth). */
  reason?: string;
  raw?: unknown;
};

export type RunRequest = {
  runId: string;
  prompt: string;
  cwd: string;
  readonly: boolean;
  timeoutS: number;
  noOutputTimeoutS: number;
  env: Record<string, string>;
  model: string | null;
  sessionId?: string;
};

export type DoctorCheck = { name: string; ok: boolean; detail: string; fix?: string };

export type DoctorReport = {
  engine: string;
  ready: boolean;
  version: string | null;
  checks: DoctorCheck[];
  flags: Record<string, boolean>;
};

export interface Engine {
  readonly name: string;
  readonly label: string;
  readonly supportsResume: boolean;
  doctor(): Promise<DoctorReport>;
  run(req: RunRequest): AsyncIterable<EngineEvent>;
  cancel(runId: string): Promise<void>;
  /** Write engine-specific rule files into the project, if the engine supports them. */
  writeRules?(cwd: string, rules: string): void;
}

/** A tiny async queue so adapters can push events from callbacks and consumers can `for await`. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}
