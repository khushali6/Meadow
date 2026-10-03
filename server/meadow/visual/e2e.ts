import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getDb, now } from "../core/db";
import { containsSecret } from "../core/redact";
import { openBrowser, type CdpPage } from "./cdp";
import { DESIGN_PROBE, designIssues, type DesignFacts } from "./design";

export const E2E_FILE = "meadow.e2e.json";
export const DESIGN_CASE = "The design holds up on a phone";

const text = z.string().min(1).max(300);
const step = z.union([
  z.object({ goto: z.string().startsWith("/").max(300) }).strict(),
  z.object({ fill: text, value: z.string().max(2000) }).strict(),
  z.object({ select: text, value: text }).strict(),
  z.object({ check: text }).strict(),
  z.object({ click: text }).strict(),
  z.object({ press: z.enum(["Enter", "Tab", "Escape"]), on: text.optional() }).strict(),
  z.object({ expect: text }).strict(),
  z.object({ expectNot: text }).strict(),
  z.object({ wait: z.number().int().min(50).max(10_000) }).strict(),
  z.object({ screenshot: text }).strict(),
]);
const testCase = z.object({
  name: text,
  path: z.string().startsWith("/").max(300).default("/"),
  /** Negative cases (invalid input) expect error messages on the page. */
  allowErrors: z.boolean().default(false),
  viewport: z.enum(["desktop", "mobile"]).default("desktop"),
  steps: z.array(step).min(1).max(80),
}).strict();
export const scenarioFile = z.object({ cases: z.array(testCase).min(1).max(40) }).strict();

export type Step = z.infer<typeof step>;
export type TestCase = z.infer<typeof testCase>;
export type CaseResult = { name: string; passed: boolean; failure: string | null; failedStep: number | null; problems: string[]; screenshots: Array<{ id: number; label: string; path: string }>; pageText: string };
export type E2eReport = { passed: boolean; cases: CaseResult[]; fileProblem: string | null };

/** The format, as shown to the coding engine when it writes or fixes the test cases. */
export const E2E_FORMAT = `${E2E_FILE} (project root) lists end-to-end test cases that Meadow runs in a real headless browser against the running app:
{
  "cases": [
    {
      "name": "Equal split of a dinner between three people",
      "path": "/",
      "steps": [
        { "fill": "Description", "value": "Dinner" },
        { "fill": "Amount", "value": "90" },
        { "click": "Add participant" },
        { "select": "Paid by", "value": "Alice" },
        { "click": "Calculate and save" },
        { "expect": "Bob owes Alice 30.00" },
        { "screenshot": "Settlement" }
      ]
    },
    { "name": "Rejects percentages that don't add up to 100", "allowErrors": true, "steps": [ { "expect": "must add up to 100" } ] }
  ]
}
Steps: fill (a field by its label, placeholder, aria-label, name or id), select (a dropdown option by its text or value), check (a checkbox or radio), click (a button or link by its text, or any element by aria-label), press (Enter, Tab or Escape, optionally "on" a field), expect / expectNot (text visible on the page), wait (milliseconds), goto (another path), screenshot (a labelled screenshot). Prefix a target with "css=" to use a CSS selector.
Cases run in order against the same running app, so they may see data saved by earlier cases (or by a person); never assume an empty database, and use names unique to each case.
Every case fails on uncaught errors, console errors, failed requests to the app, API calls that return an HTML page instead of data, and visible error messages (unless "allowErrors" is true).`;

export function loadScenarios(projectPath: string): { cases: TestCase[]; problem: string | null } {
  const file = path.join(projectPath, E2E_FILE);
  if (!fs.existsSync(file)) return { cases: [], problem: `${E2E_FILE} is missing. Write it at the project root with test cases for every main user flow.` };
  try {
    const parsed = scenarioFile.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) return { cases: [], problem: `${E2E_FILE} is invalid: ${parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}` };
    const empty = parsed.data.cases.filter(item => !item.steps.some(entry => "expect" in entry || "expectNot" in entry));
    if (empty.length) return { cases: parsed.data.cases, problem: `Every test case needs at least one "expect" step; these have none: ${empty.map(item => item.name).join(", ")}.` };
    return { cases: parsed.data.cases, problem: null };
  } catch (error) {
    return { cases: [], problem: `${E2E_FILE} is not valid JSON: ${(error as Error).message}` };
  }
}

const VIEWPORTS = { desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } } as const;
const ERROR_WORDS = /\b(error|failed|failure|unexpected|exception|could not|couldn't|cannot|can't|unable|not valid json|something went wrong)\b/i;

/** Runs inside the page: finds elements the way a person would describe them. */
const HELPER = `(() => {
  if (window.__meadow) return;
  const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)) && getComputedStyle(el).visibility !== "hidden";
  const controls = "input, textarea, select, [contenteditable=true], [role=textbox], [role=combobox]";
  const clickables = "button, a, [role=button], [role=tab], [role=link], [role=menuitem], [role=option], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], label, summary";
  function byLabel(target) {
    const t = norm(target);
    const found = [];
    for (const label of document.querySelectorAll("label")) {
      const text = norm(label.textContent);
      if (!text) continue;
      const exact = text === t;
      if (!exact && !text.includes(t)) continue;
      const control = label.control || label.querySelector(controls) || (label.htmlFor && document.getElementById(label.htmlFor));
      if (control) found.push([exact ? 0 : 2, control]);
    }
    for (const el of document.querySelectorAll(controls)) {
      for (const attr of ["aria-label", "placeholder", "name", "id", "title"]) {
        const value = norm(el.getAttribute(attr));
        if (value && (value === t || value.includes(t))) found.push([value === t ? 1 : 3, el]);
      }
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = norm(labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent).join(" "));
        if (text && (text === t || text.includes(t))) found.push([text === t ? 0 : 2, el]);
      }
    }
    return found.filter(([, el]) => visible(el)).sort((a, b) => a[0] - b[0]).map(([, el]) => el);
  }
  function byText(target) {
    const t = norm(target);
    const found = [];
    for (const el of document.querySelectorAll(clickables)) {
      if (!visible(el)) continue;
      const text = norm(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title"));
      if (text === t) found.push([0, el]);
      else if (text.includes(t)) found.push([2, el]);
    }
    if (!found.length) {
      for (const el of document.querySelectorAll("body *")) {
        if (!visible(el) || el.children.length) continue;
        if (norm(el.textContent) === t) found.push([3, el]);
      }
    }
    return found.sort((a, b) => a[0] - b[0]).map(([, el]) => el);
  }
  function find(target, kind) {
    if (target.startsWith("css=")) return Array.from(document.querySelectorAll(target.slice(4))).filter(visible)[0] || null;
    return (kind === "control" ? byLabel(target)[0] || byText(target)[0] : byText(target)[0] || byLabel(target)[0]) || null;
  }
  function setValue(el, value) {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (el.isContentEditable) el.textContent = value; else if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  window.__meadow = {
    fill(target, value) {
      const el = find(target, "control");
      if (!el) return "No field labelled \\"" + target + "\\"";
      if (el.disabled || el.readOnly) return "The field \\"" + target + "\\" is disabled";
      setValue(el, value);
      return "";
    },
    select(target, value) {
      const el = find(target, "control");
      if (!el) return "No dropdown labelled \\"" + target + "\\"";
      if (!(el instanceof HTMLSelectElement)) return "\\"" + target + "\\" is not a dropdown";
      const option = Array.from(el.options).find(o => norm(o.textContent) === norm(value) || o.value === value) || Array.from(el.options).find(o => norm(o.textContent).includes(norm(value)));
      if (!option) return "\\"" + target + "\\" has no option \\"" + value + "\\" (options: " + Array.from(el.options).map(o => o.textContent.trim()).join(", ") + ")";
      setValue(el, option.value);
      return "";
    },
    check(target) {
      const el = find(target, "control") || find(target, "click");
      if (!el) return "No checkbox or option \\"" + target + "\\"";
      el.click();
      return "";
    },
    click(target) {
      const el = find(target, "click");
      if (!el) return "Nothing to click called \\"" + target + "\\"";
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return "\\"" + target + "\\" is disabled";
      el.scrollIntoView({ block: "center" });
      el.click();
      return "";
    },
    press(key, target) {
      const el = target ? find(target, "control") : document.activeElement;
      if (!el) return "No field \\"" + target + "\\" to press " + key + " on";
      el.focus();
      for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
      if (key === "Enter" && el.form && el.tagName !== "TEXTAREA") el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      return "";
    },
    text() { return document.body ? document.body.innerText : ""; },
    alerts() {
      const nodes = document.querySelectorAll("[role=alert], [aria-live=assertive], .error, .alert-danger, .error-message, [data-error]");
      return Array.from(nodes).filter(visible).map(el => el.innerText.trim()).filter(Boolean);
    },
  };
})()`;

type Problem = { kind: string; detail: string };

class PageWatch {
  problems: Problem[] = [];
  private inflight = new Map<string, string>();
  private lastActivity = Date.now();
  private requestUrls = new Map<string, { url: string; type: string }>();

  constructor(private page: CdpPage, private origin: string) {
    page.on("Runtime.exceptionThrown", params => this.problems.push({ kind: "Uncaught error", detail: String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "unknown").split("\n").slice(0, 4).join("\n") }));
    page.on("Runtime.consoleAPICalled", params => {
      if (params.type !== "error" && params.type !== "assert") return;
      const textArgs = (params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? "").join(" ");
      this.problems.push({ kind: "Console error", detail: textArgs.slice(0, 600) });
    });
    page.on("Log.entryAdded", params => {
      const entry = params.entry;
      if (entry?.level === "error" && entry.source !== "network" && entry.source !== "violation") this.problems.push({ kind: "Browser error", detail: String(entry.text).slice(0, 600) });
    });
    page.on("Network.requestWillBeSent", params => {
      this.inflight.set(params.requestId, params.request.url);
      this.requestUrls.set(params.requestId, { url: params.request.url, type: params.type ?? "" });
      this.lastActivity = Date.now();
    });
    page.on("Network.responseReceived", params => {
      const { url, status, mimeType } = params.response;
      if (!url.startsWith(this.origin)) return;
      const api = params.type === "Fetch" || params.type === "XHR";
      if (status >= 400) this.problems.push({ kind: "Failed request", detail: `${params.type ?? "request"} ${url.slice(this.origin.length) || "/"} → HTTP ${status}` });
      else if (api && /text\/html/i.test(mimeType)) this.problems.push({ kind: "API returned a web page", detail: `${params.type} ${url.slice(this.origin.length)} → HTTP ${status} with an HTML page instead of data. The API server is probably not running, or the dev proxy points at the wrong port (another program may own it).` });
    });
    const done = (params: any) => {
      this.inflight.delete(params.requestId);
      this.lastActivity = Date.now();
    };
    page.on("Network.loadingFinished", done);
    page.on("Network.loadingFailed", params => {
      const request = this.requestUrls.get(params.requestId);
      done(params);
      if (!request || params.canceled || params.errorText === "net::ERR_ABORTED") return;
      if (request.url.startsWith(this.origin)) this.problems.push({ kind: "Failed request", detail: `${request.type || "request"} ${request.url.slice(this.origin.length) || "/"} → ${params.errorText}` });
    });
  }

  async idle(maxMs = 10_000) {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      if (this.inflight.size === 0 && Date.now() - this.lastActivity > 500) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  take(): Problem[] {
    return this.problems.splice(0);
  }
}

async function evaluate<T>(page: CdpPage, expression: string): Promise<T> {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value as T;
}

const describeStep = (entry: Step): string => {
  if ("fill" in entry) return `fill "${entry.fill}" with "${entry.value}"`;
  if ("select" in entry) return `select "${entry.value}" in "${entry.select}"`;
  if ("check" in entry) return `check "${entry.check}"`;
  if ("click" in entry) return `click "${entry.click}"`;
  if ("press" in entry) return `press ${entry.press}${entry.on ? ` on "${entry.on}"` : ""}`;
  if ("expect" in entry) return `expect "${entry.expect}"`;
  if ("expectNot" in entry) return `expect no "${entry.expectNot}"`;
  if ("wait" in entry) return `wait ${entry.wait} ms`;
  if ("goto" in entry) return `go to ${entry.goto}`;
  return `screenshot "${entry.screenshot}"`;
};
export { describeStep };

const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

/** Retries a page action for a few seconds so slow renders and transitions don't cause false failures. */
async function retry(page: CdpPage, expression: string, timeoutMs = 5000): Promise<string> {
  const until = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < until) {
    await evaluate(page, HELPER);
    last = await evaluate<string>(page, expression);
    if (!last) return "";
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return last;
}

/**
 * Runs every test case against the app at baseUrl in a fresh headless browser that can only reach localhost.
 * A built-in "loads without errors" case always runs first.
 */
export async function runEndToEnd(input: { browser: string; baseUrl: string; cases: TestCase[]; projectPath: string; projectId: number; phaseId: number | null; folder: string; design?: boolean }): Promise<CaseResult[]> {
  const outDir = path.join(input.projectPath, ".meadow", "screenshots", input.folder);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const origin = new URL(input.baseUrl).origin;
  const builtIn: TestCase[] = [{ name: "The app loads without errors", path: "/", allowErrors: false, viewport: "desktop", steps: [{ screenshot: "Home page" }] }];
  if (input.design) builtIn.push({ name: DESIGN_CASE, path: "/", allowErrors: false, viewport: "mobile", steps: [{ screenshot: "Phone" }] });
  const audits = new Map<number, "desktop" | "mobile">(input.design ? [[0, "desktop"], [1, "mobile"]] : []);
  const all: TestCase[] = [...builtIn, ...input.cases];
  const results: CaseResult[] = [];
  for (const [index, item] of all.entries()) {
    const session = await openBrowser(input.browser);
    const { page } = session;
    const result: CaseResult = { name: item.name, passed: true, failure: null, failedStep: null, problems: [], screenshots: [], pageText: "" };
    const shot = async (label: string) => {
      const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      const text = await evaluate<string>(page, "document.body ? document.body.innerText : ''").catch(() => "");
      if (containsSecret(text)) return;
      const safe = `${String(index).padStart(2, "0")}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "shot"}`;
      const file = path.join(outDir, `${safe}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      const viewport = VIEWPORTS[item.viewport];
      const id = getDb().insert("screenshots", { phase_id: input.phaseId, project_id: input.projectId, label: `${item.name} · ${label}`, path: file, viewport: `${viewport.width}x${viewport.height}`, ts: now() });
      result.screenshots.push({ id, label, path: file });
    };
    try {
      const watch = new PageWatch(page, origin);
      await Promise.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("Network.enable"), page.send("Log.enable")]);
      await page.send("Emulation.setDeviceMetricsOverride", VIEWPORTS[item.viewport]);
      const navigate = async (target: string) => {
        const loaded = page.waitFor("Page.loadEventFired", 30_000);
        const nav = await page.send("Page.navigate", { url: new URL(target, input.baseUrl).toString() });
        if (nav.errorText) throw new Error(`Couldn't open ${target}: ${nav.errorText}`);
        if (!(await loaded)) throw new Error(`${target} didn't finish loading within 30 s`);
        await watch.idle();
      };
      await navigate(item.path);
      const expects: string[] = [];
      for (const [stepIndex, entry] of item.steps.entries()) {
        let failure = "";
        if ("goto" in entry) await navigate(entry.goto);
        else if ("fill" in entry) failure = await retry(page, `window.__meadow.fill(${JSON.stringify(entry.fill)}, ${JSON.stringify(entry.value)})`);
        else if ("select" in entry) failure = await retry(page, `window.__meadow.select(${JSON.stringify(entry.select)}, ${JSON.stringify(entry.value)})`);
        else if ("check" in entry) failure = await retry(page, `window.__meadow.check(${JSON.stringify(entry.check)})`);
        else if ("click" in entry) failure = await retry(page, `window.__meadow.click(${JSON.stringify(entry.click)})`);
        else if ("press" in entry) failure = await retry(page, `window.__meadow.press(${JSON.stringify(entry.press)}, ${JSON.stringify(entry.on ?? "")})`);
        else if ("wait" in entry) await new Promise(resolve => setTimeout(resolve, entry.wait));
        else if ("screenshot" in entry) await shot(entry.screenshot);
        else if ("expect" in entry) {
          expects.push(entry.expect);
          failure = await retry(page, `(window.__meadow.text().replace(/\\s+/g, " ").toLowerCase().includes(${JSON.stringify(norm(entry.expect))}) ? "" : "Expected to see \\"" + ${JSON.stringify(entry.expect)} + "\\" on the page")`);
        } else if ("expectNot" in entry) {
          failure = await retry(page, `(window.__meadow.text().replace(/\\s+/g, " ").toLowerCase().includes(${JSON.stringify(norm(entry.expectNot))}) ? "Did not expect to see \\"" + ${JSON.stringify(entry.expectNot)} + "\\" on the page" : "")`);
        }
        await watch.idle(3000);
        if (failure) {
          result.passed = false;
          result.failure = failure;
          result.failedStep = stepIndex;
          break;
        }
      }
      await watch.idle();
      if (!item.allowErrors) {
        const alerts = await evaluate<string[]>(page, "window.__meadow ? window.__meadow.alerts() : []").catch(() => []);
        for (const alert of alerts) {
          if (ERROR_WORDS.test(alert) && !expects.some(expected => norm(alert).includes(norm(expected)))) watch.problems.push({ kind: "Error shown on the page", detail: alert.slice(0, 400) });
        }
      }
      const audit = audits.get(index);
      if (audit && result.passed) {
        const facts = await evaluate<DesignFacts | null>(page, DESIGN_PROBE).catch(() => null);
        if (facts) for (const issue of designIssues(facts, audit)) watch.problems.push({ kind: "Design", detail: issue });
      }
      result.problems = watch.take().map(problem => `${problem.kind}: ${problem.detail}`);
      result.problems = [...new Set(result.problems)];
      if (result.problems.length && result.passed) {
        result.passed = false;
        result.failure = result.problems[0];
      }
      result.pageText = (await evaluate<string>(page, "document.body ? document.body.innerText : ''").catch(() => "")).slice(0, 1500);
      const last = item.steps[item.steps.length - 1];
      if (!result.passed || !("screenshot" in last)) await shot(result.passed ? "Result" : "Failure");
    } catch (error) {
      result.passed = false;
      result.failure = (error as Error).message;
      await shot("Failure").catch(() => undefined);
    } finally {
      session.close();
    }
    results.push(result);
  }
  return results;
}

/** What the coding engine needs to reproduce and fix failing cases. */
export function failureReport(results: CaseResult[], cases: TestCase[], context: { how: string; url: string; appLog: string }): string {
  const failing = results.filter(result => !result.passed);
  const lines = [
    `${failing.length} of ${results.length} end-to-end test cases failed in a real browser.`,
    `Meadow started the app with \`${context.how}\` (no environment overrides, like a user would) and opened ${context.url}.`,
    "These checks run inside Meadow; reproduce them by starting the app the same way and using it in a browser. Fix the app (not the test cases) unless a case is genuinely wrong about the UI.",
    "",
  ];
  for (const result of failing) {
    const item = cases.find(entry => entry.name === result.name);
    lines.push(`## ${result.name}`);
    if (result.failedStep !== null && item) lines.push(`Failed at step ${result.failedStep + 1}: ${describeStep(item.steps[result.failedStep])}`);
    lines.push(`Reason: ${result.failure}`);
    if (result.problems.length) lines.push("Problems seen:", ...result.problems.slice(0, 10).map(problem => `- ${problem}`));
    if (result.pageText) lines.push(`Visible text: ${result.pageText.replace(/\s+/g, " ").slice(0, 500)}`);
    const failureShot = result.screenshots[result.screenshots.length - 1];
    if (failureShot) lines.push(`Screenshot: ${failureShot.path}`);
    lines.push("");
  }
  if (failing.some(result => result.problems.some(problem => problem.startsWith("Design:")))) lines.push("The \"Design\" problems mean the UI still looks like browser defaults. Meet the design standard from your instructions: a design-token stylesheet, deliberate typography, styled controls with hover and focus states, and a layout that fits phones.", "");
  if (context.appLog.trim()) lines.push("App output (last lines):", context.appLog.trim().split("\n").slice(-40).join("\n"));
  return lines.join("\n");
}
