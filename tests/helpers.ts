import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache } from "../server/meadow/config";
import { bus, type MeadowEvent } from "../server/meadow/core/events";
import { Db, setDb } from "../server/meadow/core/db";

export function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-test-"));
  process.env.MEADOW_HOME = path.join(root, "home");
  process.env.MEADOW_PROJECTS_DIR = path.join(root, "projects");
  process.env.MEADOW_NO_JSONL = "1";
  delete process.env.FREELLMAPI_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  fs.mkdirSync(process.env.MEADOW_HOME, { recursive: true });
  resetConfigCache();
  const db = new Db(":memory:");
  setDb(db);
  return { root, db, cleanup: () => { setDb(null); fs.rmSync(root, { recursive: true, force: true }); } };
}

export function waitForEvent(predicate: (event: MeadowEvent) => boolean, timeoutMs = 20_000): Promise<MeadowEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("Timed out waiting for event"));
    }, timeoutMs);
    const off = bus.onEvent(event => {
      if (predicate(event)) {
        clearTimeout(timer);
        off();
        resolve(event);
      }
    });
  });
}

export const settled = (projectId: number) => waitForEvent(event => event.projectId === projectId && (event.type === "execution_finished" || (event.type === "control" && ["blocked", "paused", "waiting"].includes(String(event.payload?.status)))));

export const THREE_PHASE_PLAN = `---
project: demo-app
goal: A tiny demo used by the test suite
stack: [shell]
constraints:
  - Keep it small
phases:
  - id: 1
    name: Scaffold
    tasks:
      - Create the source folder
    checks:
      - file_exists: src/index.js
    done_when: The entry file exists
  - id: 2
    name: Feature
    depends_on: [1]
    tasks:
      - Add the feature module
    checks:
      - file_exists: src/feature.js
      - cmd: test -f src/feature.js && echo feature-ok
        expect_regex: feature-ok
    done_when: The feature module exists
  - id: 3
    name: Docs
    depends_on: [2]
    tasks:
      - Write docs
    checks:
      - file_exists: docs/README.md
    done_when: Docs exist
---

Human notes.
`;
