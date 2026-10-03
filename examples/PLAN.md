---
project: habit-tracker
goal: A small web app to track daily habits with streaks
stack: [react, vite, vitest]
preview:
  command: npm run dev -- --port 5173 --strictPort
  url: http://127.0.0.1:5173
  routes: ["/"]
phases:
  - id: scaffold
    name: Project scaffold
    tasks:
      - Create a Vite + React + TypeScript app in the project root
      - Add Vitest with one passing smoke test
      - Add npm scripts build and test
      - Design system in src/styles/tokens.css - CSS variables for palette, fonts (Inter + JetBrains Mono), type scale, spacing, radii and motion, plus a reset
      - App shell - header with the product name and today's date, a max-width main column, styled buttons and inputs with hover and focus states
    checks:
      - file_exists: package.json
      - file_exists: src/styles/tokens.css
      - cmd: npm install --no-audit --no-fund
        timeout: 300
      - cmd: npm run build
      - cmd: npm test -- --run
    done_when: The app builds and the test suite runs

  - id: habits
    name: Habit list with streaks
    depends_on: [scaffold]
    tasks:
      - Add a form to create habits and a list showing them
      - Mark a habit done for today; compute the current streak
      - Persist habits in localStorage
      - Designed empty state, inline validation for blank or duplicate names, and a subtle animation when a day is checked off
      - Unit-test the streak calculation, including gaps and today/yesterday edges
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - http: /
    done_when: Habits can be added, checked off, and survive a reload; streak tests pass

  - id: weekly
    name: Weekly view
    depends_on: [habits]
    tasks:
      - Show the last seven days per habit as a row of cells with weekday labels, today highlighted in the accent colour
      - Recompose the layout for a 390px wide phone screen; nothing scrolls sideways
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - http: /
    done_when: The weekly grid renders for each habit on desktop and mobile
---

# Notes for the engine

- Keep dependencies small: React, plus the "motion" package for interface animation if needed. No component library; the look comes from the design tokens.
- Prefer small pure functions for date math so they are easy to test.
