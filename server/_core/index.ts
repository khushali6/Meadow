import { createExpressMiddleware } from "@trpc/server/adapters/express";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import { createServer } from "node:http";
import { appRouter } from "../routers";
import { Notifier } from "../meadow/channels/notifier";
import { telegram } from "../meadow/channels/telegram";
import { homePath, loadConfig, meadowHome } from "../meadow/config";
import { expireOrphanedApprovals } from "../meadow/core/approvals";
import { getDb } from "../meadow/core/db";
import { bus, eventsAfter } from "../meadow/core/events";
import { harness } from "../meadow/harness/runner";
import { screenshotFile } from "../meadow/service";
import { stopAllPreviews } from "../meadow/visual/preview";
import { serveStatic } from "./vite";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function sessionToken(): string {
  fs.mkdirSync(meadowHome(), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(homePath("session-token"), token, { mode: 0o600 });
  return token;
}

function tokenMatches(expected: string, given: string | undefined) {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function startDaemon(options: { port?: number; dev?: boolean } = {}) {
  const config = loadConfig();
  const port = options.port ?? config.server.port;
  getDb();
  const interrupted = harness.recoverOnStartup();
  expireOrphanedApprovals();
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, config.server.host, () => resolve());
  });

  await telegram.start();
  const notifier = new Notifier(telegram);
  notifier.start();

  const url = `http://${config.server.host}:${port}/?token=${token}`;
  console.log(`\n  Meadow is running locally.\n  Dashboard: ${url}\n  Data: ${meadowHome()}\n${interrupted ? `  ${interrupted} interrupted run(s) can be resumed from the dashboard or Telegram.\n` : ""}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n  Stopping Meadow…");
    notifier.stop();
    telegram.stop();
    await harness.shutdown();
    stopAllPreviews();
    server.close();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { url, server, shutdown };
}
