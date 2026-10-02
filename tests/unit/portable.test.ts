import { execFileSync, execSync } from "node:child_process";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { portableCheck } from "../../server/meadow/core/checks";
import { portableCheck } from "../../server/meadow/core/checks";
import { capture, minimalEnv } from "../../server/meadow/core/exec";
import { userPath } from "../../server/meadow/core/paths";
import { environmentChecks } from "../../server/meadow/doctor";
import { detectProject } from "../../server/meadow/setup/detect";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-portable-"));
process.env.MEADOW_HOME = path.join(dir, "home");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (file: string, text = "") => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

describe("portable paths", () => {
  it("expands ~, strips quotes and rejects relative input", () => {
    expect(userPath("~")).toBe(os.homedir());
    expect(userPath("~/code/app")).toBe(path.join(os.homedir(), "code", "app"));
    expect(userPath(`"${dir}"`)).toBe(dir);
    expect(userPath(`  ${dir}${path.sep}  `)).toBe(dir);
    expect(userPath("code/app")).toBeNull();
    expect(userPath("~other/app")).toBeNull();
  });

  it.runIf(process.platform === "win32")("accepts drive and UNC paths on Windows", () => {
    expect(userPath("C:\\Users\\me\\app")).toBe("C:\\Users\\me\\app");
    expect(userPath("\\\\server\\share\\app")).toBe("\\\\server\\share\\app");
  });
});

describe("monorepo detection", () => {
  it("finds languages in services/* and apps/* but fills verify commands the root lacks from packages", () => {
    const root = path.join(dir, "mono");
    write("mono/package.json", JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest run" }, devDependencies: { vitest: "2" } }));
    write("mono/services/payments/go.mod", "module payments\n");
    write("mono/services/ledger/pyproject.toml", "[project]\ndependencies = ['fastapi', 'psycopg']\n");
    write("mono/apps/web/package.json", JSON.stringify({ scripts: { build: "vite build", test: "jest" }, dependencies: { react: "19" } }));
    write("mono/node_modules/x/package.json", JSON.stringify({ dependencies: { mongoose: "1" } }));
    const profile = detectProject(root);
    expect(profile.packages.sort()).toEqual(["apps/web", "services/ledger", "services/payments"]);
    expect(profile.languages).toEqual(expect.arrayContaining(["JavaScript", "Go", "Python"]));
    expect(profile.frameworks).toEqual(expect.arrayContaining(["React", "FastAPI"]));
    expect(profile.databases).toContain("PostgreSQL");
    expect(profile.databases).not.toContain("MongoDB");
    expect(profile.packageManager).toBe("pnpm");
    expect(profile.commands).toEqual([
      { kind: "test", cmd: "pnpm test", source: "package.json scripts.test" },
      { kind: "build", cmd: 'cd "apps/web" && pnpm build', source: "apps/web/package.json scripts.build" },
      { kind: "build", cmd: 'cd "services/payments" && go build ./...', source: "services/payments/go.mod" },
      { kind: "lint", cmd: 'cd "services/payments" && go vet ./...', source: "services/payments/go.mod" },
    ]);
  });

  it("reads branch and remote from a worktree whose .git is a file", () => {
    write("main/.git/HEAD", "ref: refs/heads/main\n");
    write("main/.git/config", '[remote "origin"]\n\turl = https://user:secret@example.com/acme/app.git\n');
    write("main/.git/worktrees/feature/HEAD", "ref: refs/heads/feature-x\n");
    write("feature/.git", `gitdir: ${path.join(dir, "main/.git/worktrees/feature")}\n`);
    const profile = detectProject(path.join(dir, "feature"));
    expect(profile.git).toEqual({ repo: true, branch: "feature-x", remote: "https://example.com/acme/app.git" });
  });
});

describe("portable change checks", () => {
  it("passes only once the named files (or anything) differ from HEAD", () => {
    const repo = path.join(dir, "changes");
    write("changes/src/a b.ts", "one\n");
    write("changes/other.ts", "x\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-A", "-f");
    git("commit", "-qm", "init");
    const run = (cmd: string) => {
      try {
        execSync(cmd, { cwd: repo, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    const named = portableCheck.changed(["src/a b.ts"]).cmd;
    const any = portableCheck.changed([]).cmd;
    expect([run(named), run(any)]).toEqual([false, false]);
    fs.appendFileSync(path.join(repo, "other.ts"), "y\n");
    expect([run(named), run(any)]).toEqual([false, true]);
    fs.appendFileSync(path.join(repo, "src", "a b.ts"), "two\n");
    expect(run(named)).toBe(true);
  });
});

describe("cross-platform process helpers", () => {
  it("pipes stdin without a shell", async () => {
    const result = await capture(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello 'quoted' $HOME %PATH%", env: minimalEnv() });
    expect(result).toMatchObject({ code: 0, stdout: "hello 'quoted' $HOME %PATH%" });
  });

  it("resolves instead of throwing when a program is missing", async () => {
    const result = await capture("meadow-definitely-not-installed", []);
    expect(result.code).not.toBe(0);
  });

  it("reports platform and a writable data folder", () => {
    const checks = environmentChecks();
    expect(checks.find(check => check.name === "Platform")?.detail).toContain(process.arch);
    expect(checks.find(check => check.name === "Data folder")).toMatchObject({ ok: true });
  });
});
