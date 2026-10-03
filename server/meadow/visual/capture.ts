import fs from "node:fs";
import path from "node:path";
import { getDb, now } from "../core/db";
import { containsSecret } from "../core/redact";
import { browserScreenshot, findBrowser, pageText } from "./browser";

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

/** Playwright when it's installed and its Chromium starts, else a Chrome, Edge, Chromium or Brave already on this machine. */
export async function screenshotStatus(): Promise<{ ok: boolean; detail: string; backend: "playwright" | "browser" | null }> {
  const pw = await loadPlaywright();
  let pwProblem = "";
  if (pw) {
    try {
      const browser = await pw.chromium.launch({ headless: true });
      await browser.close();
      return { ok: true, detail: "Playwright Chromium", backend: "playwright" };
    } catch (error) {
      pwProblem = ` (Playwright's Chromium could not start: ${(error as Error).message.split("\n")[0]})`;
    }
  }
  const browser = await findBrowser();
  if (browser) return { ok: true, detail: `Headless ${browser}${pwProblem}`, backend: "browser" };
  return { ok: false, detail: `No browser found${pwProblem}. Install Google Chrome, Microsoft Edge or Chromium, or set MEADOW_BROWSER to a Chromium-based browser.`, backend: null };
}

/** Kept for callers that only care whether screenshots can be taken. */
export async function playwrightStatus(): Promise<{ ok: boolean; detail: string }> {
  const status = await screenshotStatus();
  return { ok: status.ok, detail: status.detail };
}

const fileFor = (outDir: string, routePath: string, viewport: string) => path.join(outDir, `${routePath === "/" ? "home" : routePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-${viewport}.png`);

/** Screenshot the project's own preview routes only. Navigation to any other origin is blocked. */
export async function captureRoutes(input: { baseUrl: string; routes: string[]; projectPath: string; projectId: number; phaseId: number | null; folder: string; viewports?: Array<keyof typeof VIEWPORTS> }): Promise<{ shots: Shot[]; skipped: string[] }> {
  const outDir = path.join(input.projectPath, ".meadow", "screenshots", input.folder);
  fs.mkdirSync(outDir, { recursive: true });
  const shots: Shot[] = [];
  const skipped: string[] = [];
  const viewports = input.viewports ?? (["desktop", "mobile"] as const);
  const record = (routePath: string, viewport: keyof typeof VIEWPORTS, file: string) => {
    const label = `${routePath} · ${viewport}`;
    const id = getDb().insert("screenshots", { phase_id: input.phaseId, project_id: input.projectId, label, path: file, viewport: `${VIEWPORTS[viewport].width}x${VIEWPORTS[viewport].height}`, ts: now() });
    shots.push({ id, label, route: routePath, viewport, path: file });
  };

  const pw = await loadPlaywright();
  const pwBrowser = pw ? await pw.chromium.launch({ headless: true }).catch(() => null) : null;
  if (pwBrowser) {
    const origin = new URL(input.baseUrl).origin;
    try {
      for (const viewport of viewports) {
        const context = await pwBrowser.newContext({ viewport: VIEWPORTS[viewport], deviceScaleFactor: viewport === "mobile" ? 2 : 1 });
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
            const file = fileFor(outDir, routePath, viewport);
            await page.screenshot({ path: file, fullPage: false });
            record(routePath, viewport, file);
          } catch (error) {
            skipped.push(`${routePath} (${viewport}): ${(error as Error).message.split("\n")[0]}`);
          }
        }
        await context.close();
      }
    } finally {
      await pwBrowser.close();
    }
    return { shots, skipped };
  }

  const browser = await findBrowser();
  if (!browser) return { shots, skipped: ["No browser for screenshots: install Google Chrome, Microsoft Edge or Chromium (or set MEADOW_BROWSER)"] };
  for (const routePath of input.routes) {
    const url = new URL(routePath, input.baseUrl).toString();
    try {
      if (containsSecret(await pageText(url))) {
        skipped.push(`${routePath}: page text looks like it contains a secret, screenshot skipped`);
        continue;
      }
    } catch (error) {
      skipped.push(`${routePath}: ${(error as Error).message.split("\n")[0]}`);
      continue;
    }
    for (const viewport of viewports) {
      const file = fileFor(outDir, routePath, viewport);
      try {
        await browserScreenshot(browser, url, file, { ...VIEWPORTS[viewport], scale: viewport === "mobile" ? 2 : 1 });
        record(routePath, viewport, file);
      } catch (error) {
        skipped.push(`${routePath} (${viewport}): ${(error as Error).message.split("\n")[0]}`);
      }
    }
  }
  return { shots, skipped };
}
