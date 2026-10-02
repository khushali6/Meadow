import express, { type Express } from "express";
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const candidates = [path.resolve(import.meta.dirname, "public"), path.resolve(import.meta.dirname, "../..", "dist", "public")];
  const distPath = candidates.find(dir => fs.existsSync(path.join(dir, "index.html")));
  if (!distPath) {
    app.use("*", (_req, res) => res.status(503).send("Dashboard is not built. Run `pnpm build` (or use `pnpm dev`)."));
    return;
  }
  app.use(express.static(distPath, { index: false }));
  app.use("*", (_req, res) => res.sendFile(path.resolve(distPath, "index.html")));
}
