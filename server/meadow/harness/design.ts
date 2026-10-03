import fs from "node:fs";
import path from "node:path";
import { homePath, loadConfig } from "../config";
import type { Plan } from "../planning/format";

const UI_STACK = /^(react|next|next\.?js|vue|nuxt|svelte|sveltekit|vite|astro|angular|solid|solidjs|remix|html|css|tailwind|tailwindcss|preact|lit|qwik|htmx|django|flask|fastapi|express|hono|rails|laravel|streamlit|gradio|electron|tauri|react[- ]native|expo|flutter|swiftui|jetpack[- ]compose|ionic|capacitor)$/i;
const UI_GOAL = /\b(web ?app|website|web site|site|landing|page|dashboard|portal|front-?end|ui|interface|app|application|admin|storefront|shop|store|blog|portfolio|tracker|calculator|game)\b/i;
const NO_UI_GOAL = /\b(cli|command[- ]line|library|sdk|package|api only|backend only|headless|daemon|cron|script|bot)\b/i;

/** Whether the plan builds something people look at: a web page, a desktop or mobile app. */
export function isWebPlan(plan: Pick<Plan, "preview" | "stack"> & { goal?: string }): boolean {
  if (plan.preview || (plan.stack ?? []).some(item => UI_STACK.test(item.trim()))) return true;
  const goal = plan.goal ?? "";
  return UI_GOAL.test(goal) && !NO_UI_GOAL.test(goal);
}

export const DESIGN_STANDARD = `This is a product people will judge on sight. Build a premium, intentional UI, never browser defaults or a bare template.
- Design tokens first: one stylesheet (or theme file) with CSS variables for colours, font families, a type scale, a 4/8px spacing scale, radii, borders and motion durations. Use the tokens everywhere; no stray hex values.
- Direction (unless the goal asks for another look): editorial and typography-led, generous whitespace, thin 1px borders as structure, restrained radius (0–8px). Warm neutral palette: background #FAF8F3, surface #F2EFE8, text #151515, muted #5E5A53, border #D8D3C9, one accent #D97706 used sparingly (active, selected, primary action), success #3F7D4A, error #B94A48. No purple/blue gradients, glassmorphism, giant shadows or glow.
- Typography: Inter, Geist or Manrope (system-ui fallbacks), monospace (JetBrains Mono / IBM Plex Mono) for numbers, dates and technical labels. A dominant heading, clear hierarchy, 16–18px body, comfortable line height, small uppercase labels with letter spacing.
- Layout: a real page structure (header, main content in a max-width container, sections on a grid), consistent spacing from the scale, aligned edges. Recompose for phones (390px) instead of shrinking; nothing may scroll sideways.
- Components: style every control. Buttons with primary (dark fill) and secondary (outline) variants; inputs with labels, padding and a visible focus ring; lists and tables with clear rows. Every interactive element has hover, focus-visible, active and disabled states.
- States: designed empty states (a short helpful message and the next action), inline validation messages next to the field, loading and success feedback. Errors are calm and readable, not raw red text.
- Motion: purposeful and quick (150–250ms for interactions, ease-out), transform/opacity only, and respect prefers-reduced-motion. For React apps, Motion (the "motion" package) for enter/exit, layout and press feedback; plain CSS transitions are fine elsewhere. Nothing loops or bounces.
- Accessibility: semantic HTML, labels on every field, 4.5:1 text contrast, keyboard reachable.
- Mobile or desktop apps (React Native, Flutter, SwiftUI, Electron, Tauri): the same rules through the platform's theme (one theme file with the tokens), native-feeling navigation, safe areas and touch targets of at least 44px.
Before finishing, open the app (in a browser at desktop and phone width, or in the simulator) and fix anything that looks unstyled, cramped, misaligned or generic.`;

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
