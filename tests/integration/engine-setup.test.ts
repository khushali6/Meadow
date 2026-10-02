import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-engine-setup-"));
process.env.MEADOW_HOME = path.join(dir, "home");
delete process.env.MEADOW_ENGINE;
const mark = path.join(dir, "signed-in");
const fakeCursor = path.join(dir, "agent");
fs.writeFileSync(
  fakeCursor,
  `#!/bin/sh
case "$1" in
  --help) echo "--print --output-format stream-json --force --trust --workspace --model";;
  --version) echo "2026.01.01-test";;
  status) if [ -f "${mark}" ]; then echo "Logged in as dev@example.com"; else echo "Not logged in"; fi;;
  login) echo "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc"; sleep 0.5; touch "${mark}";;
esac
`,
  { mode: 0o755 },
);
process.env.MEADOW_CURSOR_BIN = fakeCursor;
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const { assertEngineReady, connectEngine, scanEngines, selectEngine } = await import("../../server/meadow/setup/engines");
const { findBinary } = await import("../../server/meadow/core/exec");
const { loadConfig } = await import("../../server/meadow/config");

const waitFor = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
};

describe.skipIf(process.platform === "win32")("coding engine setup", () => {
  it("finds a CLI in a per-user bin folder that isn't on PATH", async () => {
    const home = path.join(dir, "fakehome");
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "bin", "meadow-test-cli"), "#!/bin/sh\n", { mode: 0o755 });
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(await findBinary(["meadow-test-cli"])).toBe(path.join(home, ".local", "bin", "meadow-test-cli"));
    } finally {
      process.env.HOME = previous;
    }
  });

  it("reports an installed but signed-out engine and blocks runs on it", async () => {
    const scan = await scanEngines();
    const cursor = scan.engines.find(engine => engine.name === "cursor")!;
    expect(cursor).toMatchObject({ installed: true, signedIn: false, ready: false, canLogin: true, version: "2026.01.01-test" });
    expect(scan.engines.find(engine => engine.name === "claude_code")?.status).toBe("coming_soon");
    await expect(assertEngineReady("cursor")).rejects.toThrow(/isn't connected.*Setup → Coding engine/);
  });

  it("connects through the CLI's browser sign-in and exposes the link", async () => {
    const started = await connectEngine("cursor");
    expect(started.status).toBe("running");
    expect(await waitFor(async () => (await scanEngines()).engines.find(engine => engine.name === "cursor")?.job?.url === "https://cursor.com/loginDeepControl?challenge=abc")).toBe(true);
    expect(await waitFor(async () => (await scanEngines()).engines.find(engine => engine.name === "cursor")?.ready === true)).toBe(true);
    const cursor = (await scanEngines()).engines.find(engine => engine.name === "cursor")!;
    expect(cursor.job).toMatchObject({ kind: "login", status: "done" });
    await expect(assertEngineReady("cursor")).resolves.toBeUndefined();
  });

  it("selects the connected engine as the default and recommends it", async () => {
    selectEngine("cursor", null);
    expect(loadConfig().engine.default).toBe("cursor");
    const scan = await scanEngines();
    expect(scan.recommended).toBe("cursor");
    expect(() => selectEngine("claude_code", null)).toThrow(/can't be selected/);
  });
});
