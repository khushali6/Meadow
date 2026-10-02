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
    checks:
      - file_exists: package.json
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
      - Show the last seven days per habit as a row of cells
      - Make it readable on a 390px wide phone screen
    checks:
      - cmd: npm test -- --run
      - cmd: npm run build
      - http: /
    done_when: The weekly grid renders for each habit on desktop and mobile
---

# Notes for the engine

- Keep dependencies minimal; no UI framework beyond React.
- Prefer small pure functions for date math so they are easy to test.
