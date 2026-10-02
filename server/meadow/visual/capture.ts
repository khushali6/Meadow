import fs from "node:fs";
import path from "node:path";
import { getDb, now } from "../core/db";
import { containsSecret } from "../core/redact";

export const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } } as const;

export type Shot = { id: number; label: string; route: string; viewport: keyof typeof VIEWPORTS; path: string };

type PlaywrightModule = { chromium: { launch(options: { headless: boolean }): Promise<Browser> } };
type Browser = { newContext(options: Record<string, unknown>): Promise<BrowserContext>; close(): Promise<void> };
type BrowserContext = { newPage(): Promise<Page>; route(pattern: string, handler: (route: Route) => unknown): Promise<void>; close(): Promise<void> };
type Route = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };
type Page = { goto(url: string, options: Record<string, unknown>): Promise<unknown>; screenshot(options: Record<string, unknown>): Promise<Buffer>; innerText(selector: string): Promise<string> };

export async function loadPlaywright(): Promise<PlaywrightModule | null> {
  const name = "playwright";
  try {
    return (await import(/* @vite-ignore */ name)) as PlaywrightModule;
  } catch {
    return null;
  }
}

export async function playwrightStatus(): Promise<{ ok: boolean; detail: string }> {
  const pw = await loadPlaywright();
  if (!pw) return { ok: false, detail: "Playwright is not installed. Optional: `pnpm add playwright && pnpm exec playwright install chromium`." };
  try {
    const browser = await pw.chromium.launch({ headless: true });
    await browser.close();
    return { ok: true, detail: "Chromium available" };
  } catch (error) {
    return { ok: false, detail: `Chromium could not start: ${(error as Error).message.split("\n")[0]}. Run \`pnpm exec playwright install chromium\`.` };
  }
}

/** Screenshot the project's own preview routes only. Navigation to any other origin is blocked. */
export async function captureRoutes(input: { baseUrl: string; routes: string[]; projectPath: string; projectId: number; phaseId: number | null; folder: string; viewports?: Array<keyof typeof VIEWPORTS> }): Promise<{ shots: Shot[]; skipped: string[] }> {
  const pw = await loadPlaywright();
  if (!pw) return { shots: [], skipped: ["Playwright is not installed"] };
  const origin = new URL(input.baseUrl).origin;
  const outDir = path.join(input.projectPath, ".meadow", "screenshots", input.folder);
  fs.mkdirSync(outDir, { recursive: true });
  const shots: Shot[] = [];
  const skipped: string[] = [];
  const browser = await pw.chromium.launch({ headless: true });
  try {
    for (const viewport of input.viewports ?? (["desktop", "mobile"] as const)) {
      const context = await browser.newContext({ viewport: VIEWPORTS[viewport], deviceScaleFactor: viewport === "mobile" ? 2 : 1 });
      await context.route("**/*", route => {
        const url = route.request().url();
        return url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:") ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      for (const routePath of input.routes) {
        const url = new URL(routePath, input.baseUrl).toString();
        try {
          await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
          const text = await page.innerText("body").catch(() => "");
          if (containsSecret(text)) {
            skipped.push(`${routePath} (${viewport}): page text looks like it contains a secret, screenshot skipped`);
            continue;
          }
          const safe = routePath === "/" ? "home" : routePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
          const file = path.join(outDir, `${safe}-${viewport}.png`);
          await page.screenshot({ path: file, fullPage: false });
          const label = `${routePath} · ${viewport}`;
          const id = getDb().insert("screenshots", { phase_id: input.phaseId, project_id: input.projectId, label, path: file, viewport: `${VIEWPORTS[viewport].width}x${VIEWPORTS[viewport].height}`, ts: now() });
          shots.push({ id, label, route: routePath, viewport, path: file });
        } catch (error) {
          skipped.push(`${routePath} (${viewport}): ${(error as Error).message.split("\n")[0]}`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return { shots, skipped };
}
