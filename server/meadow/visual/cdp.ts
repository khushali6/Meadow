import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { killTree, minimalEnv, spawnGroup } from "../core/exec";
import { localOnlyArgs } from "./browser";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** A minimal Chrome DevTools Protocol client over Node's built-in WebSocket, for one page. */
export class CdpPage {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(params: any) => void>>();

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ""}`));
        else entry.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("The browser closed the connection"));
      }
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<CdpPage> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("Timed out connecting to the browser")), 15_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpPage(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Couldn't connect to the browser's debugging port"));
      });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: any) => void) {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  waitFor(method: string, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.on(method, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

export type BrowserSession = { page: CdpPage; close: () => void };

/** Starts a throwaway headless browser that can only reach localhost and connects to its first page. */
export async function openBrowser(browser: string): Promise<BrowserSession> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-browser-"));
  const child: ChildProcess = spawnGroup(browser, [...localOnlyArgs(profile), "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "about:blank"], { cwd: os.tmpdir(), env: minimalEnv({ DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }) });
  const cleanup = () => {
    killTree(child);
    setTimeout(() => {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Left for the OS to clear.
      }
    }, 500).unref();
  };
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`The browser didn't start: ${stderr.trim().split("\n").pop() ?? "no output"}`)), 30_000);
      const fromFile = setInterval(() => {
        try {
          const [line] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
          if (/^\d+$/.test(line)) {
            clearTimeout(timer);
            clearInterval(fromFile);
            resolve(Number(line));
          }
        } catch {
          // Not written yet.
        }
      }, 200);
      child.stderr?.on("data", chunk => {
        stderr = (stderr + chunk.toString()).slice(-4000);
        const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) {
          clearTimeout(timer);
          clearInterval(fromFile);
          resolve(Number(match[1]));
        }
      });
      child.on("close", () => {
        clearTimeout(timer);
        clearInterval(fromFile);
        reject(new Error(`The browser exited: ${stderr.trim().split("\n").pop() ?? "no output"}`));
      });
    });
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 50 && !target; i++) {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      target = list.find(item => item.type === "page");
      if (!target) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!target) throw new Error("The browser has no page to control");
    const page = await CdpPage.connect(target.webSocketDebuggerUrl);
    return {
      page,
      close: () => {
        page.close();
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
