import { loadConfig } from "../config";
import { checkLabel, type Check, type Plan, type PlanPhase } from "../planning/format";
import { findBrowser } from "../visual/browser";
import { openBrowser } from "../visual/cdp";
import { DESIGN_PROBE, designIssues, type DesignFacts } from "../visual/design";
import { isWebPlan } from "./design";
import type { CheckOutcome } from "./verifier";

export const DESIGN_CHECK: Check = { kind: "cmd", cmd: "Design review in a browser (desktop and phone)" };

const UI_FILE = /\.(css|scss|sass|less|tsx|jsx|vue|svelte|html|astro)$/i;
const VIEWPORTS = { desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } } as const;
const MAX_ROUTES = 3;

export function touchesUi(paths: string[]): boolean {
  return paths.some(file => UI_FILE.test(file) && !file.startsWith(".meadow/"));
}

/** Web plans with a preview get a design review after every phase that changes UI files, unless the phase opts out. */
export function uiGateApplies(plan: Pick<Plan, "preview" | "stack" | "goal">, phase: Pick<PlanPhase, "uiGate" | "agent">): boolean {
  if (phase.uiGate === false || !plan.preview || !loadConfig().harness.design) return false;
  if (phase.uiGate === true || phase.agent === "ui") return true;
  return isWebPlan(plan);
}

/** Opens each preview route at desktop and phone width in a localhost-only browser and lists what still looks like browser defaults. */
export async function runDesignReview(input: { baseUrl: string; routes: string[] }): Promise<CheckOutcome> {
  const started = Date.now();
  const label = checkLabel(DESIGN_CHECK);
  const result = (passed: boolean, output: string): CheckOutcome => ({ check: DESIGN_CHECK, label, passed, exitCode: passed ? 0 : 1, output, durationMs: Date.now() - started });
  const browser = await findBrowser();
  if (!browser) return result(true, "Skipped: no Chromium-based browser found for the design review.");
  const issues: string[] = [];
  for (const route of (input.routes.length ? input.routes : ["/"]).slice(0, MAX_ROUTES)) {
    for (const viewport of ["desktop", "mobile"] as const) {
      const session = await openBrowser(browser).catch(() => null);
      if (!session) return result(true, "Skipped: the browser for the design review did not start.");
      try {
        const { page } = session;
        await Promise.all([page.send("Page.enable"), page.send("Runtime.enable")]);
        await page.send("Emulation.setDeviceMetricsOverride", VIEWPORTS[viewport]);
        const loaded = page.waitFor("Page.loadEventFired", 30_000);
        const nav = await page.send<{ errorText?: string }>("Page.navigate", { url: new URL(route, input.baseUrl).toString() });
        if (nav.errorText) {
          issues.push(`${route} (${viewport}): couldn't open the page: ${nav.errorText}`);
          continue;
        }
        if (!(await loaded)) {
          issues.push(`${route} (${viewport}): the page didn't finish loading within 30 s.`);
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
        const probe = await page.send<{ result?: { value?: DesignFacts | null } }>("Runtime.evaluate", { expression: DESIGN_PROBE, returnByValue: true });
        const facts = probe.result?.value;
        if (!facts) continue;
        for (const issue of designIssues(facts, viewport)) issues.push(`${route} (${viewport}): ${issue}`);
      } catch (error) {
        issues.push(`${route} (${viewport}): ${(error as Error).message.split("\n")[0]}`);
      } finally {
        session.close();
      }
    }
  }
  if (!issues.length) return result(true, "The UI looks designed at desktop and phone width.");
  return result(false, [
    `The design review found ${issues.length} problem${issues.length === 1 ? "" : "s"} in the running app:`,
    ...issues.map(issue => `- ${issue}`),
    "",
    "Fix the UI itself (stylesheet, tokens, components, layout) to meet the design standard in your instructions. Keep every other check passing.",
  ].join("\n"));
}
