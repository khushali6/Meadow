import { createExpressMiddleware } from "@trpc/server/adapters/express";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import { createServer } from "node:http";
import { appRouter } from "../routers";
import { Notifier } from "../meadow/channels/notifier";
import { telegram } from "../meadow/channels/telegram";
import { homePath, loadConfig, meadowHome } from "../meadow/config";
import { closeExternalClients } from "../meadow/atlas/mcpClient";
import { startActionExecutor } from "../meadow/atlas/tools";
import { migrateUnavailableEngines } from "../meadow/projects";
import { expireOrphanedApprovals, sweepExpiredApprovals } from "../meadow/core/approvals";
import { getDb } from "../meadow/core/db";
import { bus, eventsAfter, startForeignEventRelay } from "../meadow/core/events";
import { harness } from "../meadow/harness/runner";
import { startHealthMonitor } from "../meadow/setup/health";
import { liveGraph } from "../meadow/setup/live";
import { screenshotFile } from "../meadow/service";
import { stopAllPreviews } from "../meadow/visual/preview";
import { serveStatic } from "./vite";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function sessionToken(): string {
  fs.mkdirSync(meadowHome(), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(homePath("session-token"), token, { mode: 0o600 });
  fs.chmodSync(homePath("session-token"), 0o600);
  return token;
}

function tokenMatches(expected: string, given: string | undefined) {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const lockFile = () => homePath("daemon.json");

/** One daemon per MEADOW_HOME: a second one would double-poll Telegram and race the first for runs. */
function acquireDaemonLock() {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile(), "utf8")) as { pid: number; url?: string };
    if (held.pid !== process.pid) {
      process.kill(held.pid, 0);
      throw new Error(`Meadow is already running (pid ${held.pid}${held.url ? `, ${held.url.split("?")[0]}` : ""}). Stop it first, or set MEADOW_HOME to run a separate instance.`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH" && !(error instanceof SyntaxError)) {
      if (code === "EPERM") throw new Error(`Another user's Meadow process holds ${lockFile()}. Stop it or delete the file if it is stale.`);
      throw error;
    }
  }
}

function listen(server: ReturnType<typeof createServer>, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Binds the configured port; when the user didn't ask for a specific one, walks up to ten ports further. */
async function bindPort(server: ReturnType<typeof createServer>, preferred: number, host: string, explicit: boolean): Promise<number> {
  const attempts = explicit ? 1 : 10;
  for (let offset = 0; offset < attempts; offset++) {
    try {
      await listen(server, preferred + offset, host);
      return preferred + offset;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES") throw new Error(`Port ${preferred + offset} needs elevated permissions on this system. Use a port above 1024 with --port.`);
      if (code === "EADDRNOTAVAIL") throw new Error(`Can't bind ${host}. Check server.host in config (it should be 127.0.0.1).`);
      if (code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(explicit ? `Port ${preferred} is in use. Pick another with --port, or stop whatever is using it.` : `Ports ${preferred}-${preferred + attempts - 1} are all in use. Pick a free one with --port.`);
}

export async function startDaemon(options: { port?: number; dev?: boolean } = {}) {
  const config = loadConfig();
  acquireDaemonLock();
  getDb();
  const migrated = migrateUnavailableEngines();
  const interrupted = harness.recoverOnStartup();
  expireOrphanedApprovals();
  getDb().run("UPDATE atlas_actions SET status = CASE status WHEN 'running' THEN 'interrupted' ELSE 'expired' END, finished_at = ? WHERE status IN ('pending', 'running')", new Date().toISOString());
  getDb().run("UPDATE atlas_investigations SET status = 'failed', answer = 'Meadow stopped during this investigation.' WHERE status = 'running'");
  startActionExecutor();
  const stopRelay = startForeignEventRelay();
  const sweep = setInterval(() => sweepExpiredApprovals(), 30_000);
  sweep.unref();
  const token = sessionToken();

  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);

  // DNS-rebinding guard: only accept requests addressed to a loopback host name.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOCAL_HOSTS.has(host)) return res.status(403).send("Meadow only answers on localhost.");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (!options.dev) res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    next();
  });
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "meadow", timestamp: new Date().toISOString() }));

  // Every other API route needs the session token printed at startup. No CORS headers are ever sent.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const given = (req.headers["x-meadow-token"] as string | undefined) ?? (typeof req.query.token === "string" ? req.query.token : undefined);
    if (!tokenMatches(token, given)) return res.status(401).json({ error: "Missing or invalid Meadow session token. Open the URL printed by `meadow start`." });
    next();
  });

  app.get("/api/events", (req: Request, res: Response) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const after = Number(req.headers["last-event-id"] ?? req.query.after ?? 0) || 0;
    const write = (event: { id: number }) => res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    res.flushHeaders();
    res.write(": connected\n\n");
    for (const event of eventsAfter(after, undefined, 1000)) write(event);
    const unsubscribe = bus.onEvent(write);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      unsubscribe();
      clearInterval(ping);
    });
  });

  app.get("/api/screenshots/:id", (req: Request, res: Response) => {
    const file = screenshotFile(Number(req.params.id));
    if (!file) return res.status(404).end();
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(file);
  });

  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext: () => ({}) }));

  if (options.dev) {
    // Kept opaque to the bundler so the production build never pulls in vite.
    const devModule = "./viteDev";
    const { setupVite } = (await import(/* @vite-ignore */ devModule)) as typeof import("./viteDev");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = await bindPort(server, options.port ?? config.server.port, config.server.host, options.port !== undefined || Boolean(process.env.MEADOW_PORT));

  await telegram.start();
  const notifier = new Notifier(telegram);
  notifier.start();
  if (config.atlas.liveUpdate) liveGraph.start({ isBusy: id => harness.isActive(id) });
  const stopHealth = startHealthMonitor();
  if (interrupted.length && config.harness.autoResume) setTimeout(() => harness.autoResume(interrupted), 5_000).unref();

  const url = `http://${config.server.host}:${port}/?token=${token}`;
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, url: `http://${config.server.host}:${port}/` }), { mode: 0o600 });
  if (port !== config.server.port && options.port === undefined) console.log(`  Port ${config.server.port} was busy, using ${port}.`);
  console.log(`\n  Meadow is running locally.\n  Dashboard: ${url}\n  Data: ${meadowHome()}\n${interrupted.length ? `  ${interrupted.length} interrupted run(s) ${config.harness.autoResume ? "will resume automatically" : "can be resumed from the dashboard or Telegram"}.\n` : ""}${migrated.map(item => `  ${item.project}: ${item.from} is not available yet, switched to ${item.to}.\n`).join("")}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n  Stopping Meadow…");
    notifier.stop();
    telegram.stop();
    liveGraph.stop();
    stopHealth();
    stopRelay();
    clearInterval(sweep);
    await closeExternalClients();
    await harness.shutdown();
    stopAllPreviews();
    server.close();
    try {
      if ((JSON.parse(fs.readFileSync(lockFile(), "utf8")) as { pid: number }).pid === process.pid) fs.rmSync(lockFile());
    } catch {
      /* already gone */
    }
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { url, server, shutdown };
}
