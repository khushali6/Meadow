/** What the browser measures on a page to tell a designed UI from browser defaults. Computed styles only, no judgement calls. */
export type DesignFacts = {
  bodyFont: string;
  bodyMargin: string;
  cssRules: number;
  hoverRules: number;
  focusRules: number;
  interactive: number;
  nativeControls: string[];
  bodySize: number;
  largestText: number;
  colors: number;
  /** Widest of the page content and the layout viewport, in CSS px. */
  contentWidth: number;
  viewportWidth: number;
  /** The emulated screen width; on phones the layout viewport can grow past it to fit wide content. */
  deviceWidth: number;
  viewportMeta: boolean;
};

export const DESIGN_PROBE = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  const body = document.body;
  if (!body) return null;
  const bodyStyle = getComputedStyle(body);
  let cssRules = 0, hoverRules = 0, focusRules = 0;
  const walk = list => { for (const rule of list) { cssRules++; const sel = rule.selectorText || ""; if (sel.includes(":hover")) hoverRules++; if (sel.includes(":focus")) focusRules++; if (rule.cssRules) walk(rule.cssRules); } };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { cssRules += 20; } }
  const elements = [...body.querySelectorAll("*")].filter(visible).slice(0, 2000);
  const controls = elements.filter(el => el.matches("button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), select, textarea, [role=button]"));
  const nativeControls = controls.filter(el => {
    const s = getComputedStyle(el);
    const bg = s.backgroundColor.replace(/\\s/g, "");
    return s.borderTopStyle === "outset" || s.borderTopStyle === "inset" || ((bg === "rgb(239,239,239)" || bg === "rgb(240,240,240)") && el.matches("button, input[type=button], input[type=submit], [role=button]"));
  }).map(el => (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.tagName.toLowerCase()).trim().slice(0, 40));
  const colors = new Set();
  let largestText = 0;
  for (const el of elements) {
    const s = getComputedStyle(el);
    colors.add(s.color);
    if (s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent") colors.add(s.backgroundColor);
    if (s.borderTopStyle !== "none" && parseFloat(s.borderTopWidth) > 0) colors.add(s.borderTopColor);
    if ([...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) largestText = Math.max(largestText, parseFloat(s.fontSize) || 0);
  }
  colors.add(bodyStyle.color);
  const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  if (bodyStyle.backgroundColor !== "rgba(0, 0, 0, 0)") colors.add(bodyStyle.backgroundColor); else if (htmlBg !== "rgba(0, 0, 0, 0)") colors.add(htmlBg);
  return {
    bodyFont: bodyStyle.fontFamily,
    bodyMargin: bodyStyle.margin,
    cssRules, hoverRules, focusRules,
    interactive: elements.filter(el => el.matches("button, a[href], input, select, textarea, [role=button]")).length,
    nativeControls,
    bodySize: parseFloat(bodyStyle.fontSize) || 16,
    largestText,
    colors: colors.size,
    contentWidth: Math.max(document.documentElement.scrollWidth, window.innerWidth),
    viewportWidth: window.innerWidth,
    deviceWidth: screen.width,
    viewportMeta: Boolean(document.querySelector("meta[name=viewport]")),
  };
})()`;

const DEFAULT_FONTS = new Set(["", "times", "times new roman", "serif"]);

/** Every way the page still looks like browser defaults. Empty when it looks designed. */
export function designIssues(facts: DesignFacts, scope: "desktop" | "mobile" = "desktop"): string[] {
  const issues: string[] = [];
  const screen = scope === "mobile" ? facts.deviceWidth : facts.viewportWidth;
  if (scope === "mobile" && !facts.viewportMeta) issues.push(`On a phone the page renders ${facts.contentWidth}px wide and zoomed out. Add <meta name="viewport" content="width=device-width, initial-scale=1"> and a responsive layout.`);
  else if (facts.contentWidth - screen > 2) issues.push(`The page scrolls sideways by ${facts.contentWidth - screen}px on a ${screen}px wide screen. Make the layout fit (fluid widths, wrapping, min-width: 0).`);
  if (scope === "mobile") return issues;
  const firstFont = facts.bodyFont.split(",")[0].replace(/["']/g, "").trim().toLowerCase();
  if (DEFAULT_FONTS.has(firstFont)) issues.push(`The text uses the browser's default font (${facts.bodyFont || "none set"}). Set a deliberate font stack on the body (for example Inter, Geist or Manrope with system-ui fallbacks).`);
  if (facts.cssRules < 30) issues.push(`The app has almost no styling (${facts.cssRules} CSS rules). Add a real stylesheet: design tokens as CSS variables, layout, typography and component styles.`);
  if (facts.bodyMargin === "8px") issues.push("The body still has the browser's default 8px margin, so there is no CSS reset or page layout. Add a reset and a centred, padded content container.");
  if (facts.nativeControls.length) issues.push(`These controls still look like unstyled browser defaults: ${[...new Set(facts.nativeControls)].slice(0, 6).map(label => `"${label}"`).join(", ")}. Style buttons, inputs and selects (padding, border, radius, colours, font).`);
  if (facts.largestText > 0 && facts.largestText < facts.bodySize * 1.5) issues.push(`There is no visual hierarchy: the largest text is ${Math.round(facts.largestText)}px against ${Math.round(facts.bodySize)}px body text. Give the page a clear heading at least 1.5× the body size.`);
  if (facts.colors < 5) issues.push(`The page uses only ${facts.colors} colours. Define a palette (background, surface, text, muted text, border, one accent) and use it.`);
  if (facts.interactive > 0 && facts.hoverRules === 0) issues.push("Nothing reacts on hover. Add hover styles (and a short transition) to buttons, links and other controls.");
  if (facts.interactive > 0 && facts.focusRules === 0) issues.push("There are no focus styles. Add visible :focus-visible styles so keyboard users can see where they are.");
  return issues;
}
