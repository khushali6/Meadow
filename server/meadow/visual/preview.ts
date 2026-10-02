import type { ChildProcess } from "node:child_process";
import { killTree, minimalEnv, spawnGroup } from "../core/exec";
import { isLocalUrl, type Preview } from "../planning/format";

const active = new Set<ChildProcess>();

export class PreviewHandle {
  constructor(readonly url: string, private child: ChildProcess | null, readonly log: () => string) {}

  stop() {
    if (this.child) {
      killTree(this.child);
      active.delete(this.child);
      this.child = null;
    }
  }
}

async function responds(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    clearTimeout(timer);
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Start the plan's preview command and wait for its localhost URL to respond. Always pair with stop(). */
export async function startPreview(preview: Preview, cwd: string): Promise<PreviewHandle> {
  if (!isLocalUrl(preview.url)) throw new Error(`Preview URL ${preview.url} is not on localhost; refusing to start.`);
  if (await responds(preview.url)) throw new Error(`Something is already listening on ${preview.url}. Stop it so Meadow can start this project's preview.`);
  const port = new URL(preview.url).port;
  const child = spawnGroup(preview.command, [], { cwd, env: minimalEnv({ PORT: port || undefined, BROWSER: "none", NODE_ENV: "development" }), shell: true });
  active.add(child);
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let exited = false;
  child.on("close", () => {
    exited = true;
    active.delete(child);
  });
  const handle = new PreviewHandle(preview.url, child, () => output);
  const deadline = Date.now() + preview.readyTimeoutS * 1000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Preview command exited before ${preview.url} was ready:\n${output.slice(-2000)}`);
    if (await responds(preview.url)) return handle;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  handle.stop();
  throw new Error(`Preview did not respond at ${preview.url} within ${preview.readyTimeoutS}s:\n${output.slice(-2000)}`);
}

export function stopAllPreviews() {
  for (const child of Array.from(active)) killTree(child);
  active.clear();
}

process.once("exit", stopAllPreviews);
