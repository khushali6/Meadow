import fs from "node:fs";
import path from "node:path";
import { homePath, loadConfig } from "../config";
import type { Plan } from "../planning/format";
import { LlmRouter } from "../llm/router";

const UI_STACK = /^(react|next|next\.?js|vue|nuxt|svelte|sveltekit|vite|astro|angular|solid|solidjs|remix|html|css|tailwind|tailwindcss|preact|lit|qwik|htmx|django|flask|fastapi|express|hono|rails|laravel|streamlit|gradio|electron|tauri|react[- ]native|expo|flutter|swiftui|jetpack[- ]compose|ionic|capacitor)$/i;
const UI_GOAL = /\b(web ?app|website|web site|site|landing|page|dashboard|portal|front-?end|ui|interface|app|application|admin|storefront|shop|store|blog|portfolio|tracker|calculator|game)\b/i;
const NO_UI_GOAL = /\b(cli|command[- ]line|library|sdk|package|api only|backend only|headless|daemon|cron|script|bot)\b/i;

/** Whether the plan builds something people look at: a web page, a desktop or mobile app. */
export function isWebPlan(plan: Pick<Plan, "preview" | "stack"> & { goal?: string }): boolean {
  if (plan.preview || (plan.stack ?? []).some(item => UI_STACK.test(item.trim()))) return true;
  const goal = plan.goal ?? "";
  return UI_GOAL.test(goal) && !NO_UI_GOAL.test(goal);
}

/** Free, well-maintained libraries the engine may use instead of hand-rolling every control. */
export const APPROVED_LIBRARIES = `Use proven free libraries instead of hand-rolling complex controls, themed entirely from the tokens:
- React: shadcn/ui (Radix primitives, copied into src/components/ui) for dialogs, menus, selects, tabs, tooltips, popovers, toasts; Sonner for toasts; cmdk for command menus; Lucide for icons; Recharts for charts.
- Vue: Radix Vue / shadcn-vue. Svelte: Bits UI / shadcn-svelte. Plain HTML: native elements styled from the tokens.
- No heavyweight kits with their own look (MUI, Ant Design, Bootstrap, Chakra) — the product must look like itself, not a template.`;

export const DESIGN_STANDARD = `This is a product people will judge on sight. Build a premium, intentional UI — never browser defaults or a bare template.

## Tokens first
One stylesheet (or theme file) with CSS variables for colours, font families, a type scale, a 4/8px spacing scale, radii, borders and motion durations. Use the tokens everywhere; no stray hex values anywhere else.

## Visual direction (baseline — override with a project-specific design.md if present)
Editorial and typography-led: generous whitespace, thin 1px borders as structure, restrained radius (0–8px).
- Background: #FAF8F3  Surface: #F2EFE8  Text: #151515  Muted: #5E5A53  Border: #D8D3C9
- Accent: #D97706 (used sparingly — active state, selected item, primary action only)
- Success: #3F7D4A  Error: #B94A48  Warning: #B7791F
- No purple/blue gradients, glassmorphism, giant shadows or glow effects.

## Typography
Inter Variable (or Geist / Manrope with system-ui fallback) for all text. JetBrains Mono (or IBM Plex Mono) for numbers, dates and technical labels. Dominant heading, clear hierarchy, 16–18px body, comfortable line-height. Small uppercase labels with letter-spacing.

## Layout
Real page structure: header, max-width main column, sections on a grid. Consistent spacing from the scale, aligned edges. Recompose for phones (390px) — never shrink, never scroll sideways.

## Components
${APPROVED_LIBRARIES}
Buttons: primary (dark fill) + secondary (outline). Inputs: labels, padding, visible focus ring. Lists and tables: clear rows with hover states. Every interactive element has hover, focus-visible, active and disabled states. Designed empty states with a helpful message and the next action. Inline validation next to the field, calm error messages.

## Motion
Animation shows state, progress, hierarchy or feedback — never decoration. One library per job:
- Motion (\`motion/react\`): buttons, hover/press, dialogs, menus, drawers, AnimatePresence status changes, layout transitions.
- GSAP (\`gsap\` + \`@gsap/react\` useGSAP): page-level choreography — hero/headline reveal, section transitions, ScrollTrigger storytelling.
- Anime.js (\`animejs\`): technical visuals — SVG line drawing, timelines, staggered log/terminal rows, small activity indicators.
Timing: hover/press 150–250ms, UI transitions 250–450ms, entrances 400–700ms, list stagger 40–80ms. Press scale 0.97–0.99, hover lift 1–2px. Ease-out or soft springs, never bouncy or elastic.
Nothing loops except tiny activity indicators. Clean up timelines on unmount. Respect \`prefers-reduced-motion\` (keep opacity/state changes, drop movement). Lighter on phones.

## Accessibility
Semantic HTML. Label on every field. 4.5:1 text contrast. Full keyboard reachability.

## Mobile / desktop apps (React Native, Flutter, SwiftUI, Electron, Tauri)
Same rules through the platform's theme file. Native-feeling navigation, safe areas respected, touch targets ≥ 44px.

Before finishing each phase, open the app at desktop and phone width (or in the simulator) and fix anything that looks unstyled, cramped, misaligned or generic.`;

/** The design brief for this project: the project's .meadow/design.md, else ~/.meadow/design.md, else the built-in standard. */
export function designBrief(projectPath: string): string {
  for (const file of [path.join(projectPath, ".meadow", "design.md"), homePath("design.md")]) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) return text.slice(0, 6000);
    } catch {
      // Fall through to the next source.
    }
  }
  return DESIGN_STANDARD;
}

/** The brief to give the engine for this plan, or "" when the plan has no UI or the standard is turned off. */
export function designSection(plan: Pick<Plan, "preview" | "stack"> & { goal?: string }, projectPath: string): string {
  if (!loadConfig().harness.design || !isWebPlan(plan)) return "";
  return designBrief(projectPath);
}

// ---------------------------------------------------------------------------
// LLM-powered unique design brief generation
// ---------------------------------------------------------------------------

const BRIEF_SYSTEM = `You are a senior product designer. Your job is to write a concrete, opinionated design specification for a software product so that a coding AI can implement exactly the right look, feel, and motion without making any aesthetic decisions itself.

Rules:
- Be specific: exact hex values, exact font names, exact millisecond values, exact easing curves.
- Make it feel like a real, intentional brand — not a generic template. Derive a unique palette and visual character from the user's reference prompt.
- Components come from shadcn/ui (Radix) or the stack's equivalent, themed only through the tokens you define; never MUI, Ant Design, Bootstrap or Chakra.
- Motion follows one library per job: Motion for React interactions, GSAP for page choreography, Anime.js for technical/SVG sequences.
- Keep the output under 900 words. Use markdown headings and bullet lists. No preamble, no closing remarks.

Output exactly these sections:
## Visual character
## Palette (exact hex values for: background, surface, text, muted, border, accent, accent-hover, success, error, warning)
## Typography (font family choices, size scale, weights, letter-spacing)
## Spacing & layout
## Motion (animation library, timing, easing, specific animations for: page enter, component mount, hover, press, list stagger)
## Core components (list the first 5 components to build with their key visual traits)
## Responsive strategy (how layout changes at 390px / 768px / 1280px)`;

/**
 * LLM-powered: expand `plan.ui.prompt` into a full per-project design specification.
 * Writes the result to `<projectPath>/.meadow/design.md` so all phases pick it up via `designBrief()`.
 * Returns the brief text. Falls back to `DESIGN_STANDARD` if the LLM is unavailable.
 */
export async function generateUiDesignBrief(
  plan: Plan,
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const designFile = path.join(projectPath, ".meadow", "design.md");

  // Already generated for this project — don't call the LLM again.
  if (fs.existsSync(designFile)) {
    const existing = fs.readFileSync(designFile, "utf8").trim();
    if (existing) return existing;
  }

  const ui = plan.ui;
  if (!ui?.prompt) return DESIGN_STANDARD;

  const animLib = ui.animations ?? "motion";
  const refHint = ui.reference ? `\n\nVisual reference (site for inspiration): ${ui.reference}` : "";

  const userMsg = [
    `Project: ${plan.project}`,
    `Goal: ${plan.goal}`,
    `Stack: ${plan.stack.join(", ") || "web"}`,
    `Animation library: ${animLib}`,
    `Visual direction from the product owner: ${ui.prompt}${refHint}`,
  ].join("\n");

  try {
    const llm = new LlmRouter();
    const result = await llm.chat(
      [
        { role: "system", content: BRIEF_SYSTEM },
        { role: "user", content: userMsg },
      ],
      { maxTokens: 1400, temperature: 0.4, signal },
    );

    const brief = result.text.trim();
    if (!brief) return DESIGN_STANDARD;

    // Prepend a header so it reads well when injected into phase prompts.
    const fullBrief = [
      `# Design system for ${plan.project}`,
      `_Generated from the product owner's visual direction: "${ui.prompt}"_`,
      "",
      brief,
      "",
      "---",
      "**Baseline rules that always apply:**",
      ...APPROVED_LIBRARIES.split("\n").map(line => (line.startsWith("-") ? line : `- ${line}`)),
      "- Every interactive element needs hover, focus-visible, active and disabled states.",
      `- Animations: use the \`${animLib}\` library. Always respect \`prefers-reduced-motion\`.`,
      "- Semantic HTML, labels on every field, keyboard reachable, 4.5:1 contrast minimum.",
      "- Before finishing each phase, open the app and fix anything that looks unstyled, cramped or generic.",
    ].join("\n");

    // Persist so subsequent phases don't need another LLM call.
    fs.mkdirSync(path.join(projectPath, ".meadow"), { recursive: true });
    fs.writeFileSync(designFile, fullBrief, "utf8");
    return fullBrief;
  } catch {
    // LLM unavailable — fall back to the universal baseline.
    return DESIGN_STANDARD;
  }
}
