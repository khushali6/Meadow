import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyExternal } from "../../server/meadow/atlas/mcpClient";
import { backoffMs, RECONNECT_STEPS } from "../../server/meadow/channels/telegram";
import { loadConfig, resetConfigCache } from "../../server/meadow/config";
import { Db, MigrationError } from "../../server/meadow/core/db";
import { checkForUpdate, compareVersions, downloadUpdate, signedPayload, verifyManifest } from "../../server/meadow/core/updates";
import { detectProject, profileLines } from "../../server/meadow/setup/detect";
import { discoverMcp, importMcp, McpImportError } from "../../server/meadow/setup/mcp";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
});
afterEach(() => env.cleanup());

const write = (root: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};

describe("project detection", () => {
  it("infers stack, tooling and commands from marker files", () => {
    const root = path.join(env.root, "app");
    write(root, "package.json", JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest", build: "vite build", dev: "vite" }, dependencies: { react: "19", pg: "8" }, devDependencies: { typescript: "5", vitest: "3", vite: "7" } }));
    write(root, "pnpm-lock.yaml", "");
    write(root, ".github/workflows/ci.yml", "on: push");
    write(root, "Dockerfile", "FROM node");
    write(root, "docker-compose.yml", "services:\n  db:\n    image: postgres:16\n");
    write(root, ".env.example", "DATABASE_URL=postgres://x\nSTRIPE_KEY=\n");
    write(root, ".env", "STRIPE_KEY=sk_live_secret");
    write(root, ".git/HEAD", "ref: refs/heads/main\n");
    write(root, ".git/config", '[remote "origin"]\n\turl = https://user:token@github.com/acme/app.git\n');
    const profile = detectProject(root);
    expect(profile.languages).toContain("TypeScript");
    expect(profile.frameworks).toEqual(expect.arrayContaining(["React", "Vite"]));
    expect(profile.packageManager).toBe("pnpm");
    expect(profile.testFrameworks).toContain("Vitest");
    expect(profile.databases).toEqual(expect.arrayContaining(["PostgreSQL"]));
    expect(profile.ci).toContain("GitHub Actions");
    expect(profile.docker).toEqual({ dockerfile: true, compose: true });
    expect(profile.git).toEqual({ repo: true, branch: "main", remote: "https://github.com/acme/app.git" });
    expect(profile.envExampleKeys).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    expect(JSON.stringify(profile)).not.toContain("sk_live_secret");
    expect(profile.commands.map(command => command.cmd)).toEqual(["pnpm typecheck", "pnpm lint", "pnpm test -- --run", "pnpm build"]);
    expect(profileLines(profile)).toEqual(expect.arrayContaining(["TypeScript detected", "React detected", "pnpm package manager", "Git repository (main)"]));
  });

  it("covers Python, Go and Rust, and reports nothing for an empty folder", () => {
    const py = path.join(env.root, "py");
    write(py, "pyproject.toml", '[project]\ndependencies = ["fastapi", "sqlalchemy"]\n[tool.ruff]\n[project.optional-dependencies]\ndev = ["pytest", "mypy"]\n');
    write(py, "uv.lock", "");
    const profile = detectProject(py);
    expect(profile.languages).toEqual(["Python"]);
    expect(profile.frameworks).toContain("FastAPI");
    expect(profile.commands.map(command => command.cmd)).toEqual(expect.arrayContaining(["uv run pytest -q", "ruff check .", "mypy ."]));
    const go = path.join(env.root, "go");
    write(go, "go.mod", "module x");
    expect(detectProject(go).commands.map(command => command.kind)).toEqual(["build", "test", "lint"]);
    const empty = path.join(env.root, "empty");
    fs.mkdirSync(empty);
    expect(profileLines(detectProject(empty))).toEqual(["No known project markers found"]);
  });
});

describe("MCP discovery", () => {
  it("lists servers without reading secret values and imports only stdio ones", () => {
    const root = path.join(env.root, "repo");
    write(root, ".mcp.json", JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_literal_value", OTHER_SECRET: "nope" } }, "remote api": { url: "https://mcp.example.com" } } }));
    write(root, ".cursor/mcp.json", JSON.stringify({ mcpServers: { github: { command: "other" }, pg: { command: "postgres-mcp" } } }));
    const found = discoverMcp(root);
    expect(found.map(item => item.name)).toEqual(["github", "remote-api", "pg"]);
    const github = found[0];
    expect(github).toMatchObject({ service: "GitHub", transport: "stdio", source: ".mcp.json", passableSecrets: ["GITHUB_TOKEN"], missingSecrets: ["OTHER_SECRET"], imported: false });
    expect(JSON.stringify(found)).not.toContain("ghp_literal_value");
    importMcp(root, "github");
    resetConfigCache();
    expect(loadConfig().atlas.mcpServers).toEqual([{ name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: ["GITHUB_TOKEN"] }]);
    expect(discoverMcp(root).find(item => item.name === "github")?.imported).toBe(true);
    expect(() => importMcp(root, "remote-api")).toThrow(McpImportError);
    expect(() => importMcp(root, "missing")).toThrow(McpImportError);
  });

  it("classifies external tools as read, write or destructive", () => {
    expect(classifyExternal("list_issues", { readOnlyHint: true })).toBe("READ");
    expect(classifyExternal("list_issues")).toBe("WRITE");
    expect(classifyExternal("create_issue")).toBe("WRITE");
    expect(classifyExternal("delete_branch", { readOnlyHint: true })).toBe("DESTRUCTIVE");
    expect(classifyExternal("merge_pull_request")).toBe("DESTRUCTIVE");
    expect(classifyExternal("update_file", { destructiveHint: true })).toBe("DESTRUCTIVE");
    expect(classifyExternal("read_file", { readOnlyHint: true, destructiveHint: true })).toBe("DESTRUCTIVE");
  });
});

describe("Telegram reconnect backoff", () => {
  it("steps 1s, 2s, 5s, 10s, 30s, 60s with ±30% jitter and stays at 60s", () => {
    RECONNECT_STEPS.forEach((step, i) => {
      expect(backoffMs(i, () => 0)).toBe(step * 700);
      expect(backoffMs(i, () => 1)).toBe(step * 1300);
      expect(backoffMs(i, () => 0.5)).toBe(step * 1000);
    });
    expect(backoffMs(50, () => 0.5)).toBe(60_000);
  });
});

describe("database migrations", () => {
  const BASE = ["CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)", "ALTER TABLE notes ADD COLUMN tag TEXT"];

  it("backs up before upgrading an existing database and keeps the newest five", () => {
    const file = path.join(env.root, "db", "meadow.db");
    const first = new Db(file, BASE.slice(0, 1));
    expect(first.lastBackup).toBeNull();
    first.raw.prepare("INSERT INTO notes (body) VALUES (?)").run("hello");
    first.close();
    const second = new Db(file, BASE);
    expect(second.lastBackup).toMatch(/backups\/meadow-v1-.*\.db$/);
    expect(fs.statSync(second.lastBackup!).mode & 0o777).toBe(0o600);
    expect(second.schemaVersion()).toBe(2);
    second.close();
    const dir = path.join(env.root, "db", "backups");
    for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `meadow-v0-2020-01-0${i}.db`), "");
    const third = new Db(file, [...BASE, "CREATE TABLE extra (id INTEGER)"]);
    expect(fs.readdirSync(dir)).toHaveLength(5);
    expect(fs.readdirSync(dir)).toContain(path.basename(third.lastBackup!));
    third.close();
  });

  it("restores the backup when a migration fails", () => {
    const file = path.join(env.root, "db2", "meadow.db");
    const db = new Db(file, BASE.slice(0, 1));
    db.raw.prepare("INSERT INTO notes (body) VALUES (?)").run("keep me");
    db.close();
    expect(() => new Db(file, [...BASE.slice(0, 1), "ALTER TABLE notes ADD COLUMN tag TEXT", "THIS IS NOT SQL"])).toThrow(MigrationError);
    const reopened = new Db(file, BASE.slice(0, 1));
    expect(reopened.schemaVersion()).toBe(1);
    expect(reopened.raw.prepare("SELECT body FROM notes").get()).toEqual({ body: "keep me" });
    expect(reopened.raw.prepare("SELECT name FROM pragma_table_info('notes') WHERE name = 'tag'").get()).toBeUndefined();
    reopened.close();
  });
});

describe("signed updates", () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = Buffer.from("release-bytes");
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const manifest = (version: string, overrides: Record<string, string> = {}) => {
    const base = { version, url: "https://releases.example.com/meadow.tgz", sha256 };
    return { ...base, signature: crypto.sign(null, Buffer.from(signedPayload(base)), keys.privateKey).toString("base64"), notes: "Fixes", ...overrides };
  };
  const fetcher = (body: unknown) => (async (url: string | URL | Request) => (String(url).endsWith(".tgz") ? new Response(payload) : Response.json(body))) as typeof fetch;

  it("compares versions", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("v2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("trusts only manifests signed by the publisher key", () => {
    expect(verifyManifest(manifest("9.0.0"), publicKey).version).toBe("9.0.0");
    expect(() => verifyManifest(manifest("9.0.0", { url: "https://evil.example.com/x.tgz" }), publicKey)).toThrow(/signature/);
    expect(() => verifyManifest(manifest("9.0.0", { url: "http://releases.example.com/meadow.tgz" }), publicKey)).toThrow(/HTTPS/);
    const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyManifest(manifest("9.0.0"), other)).toThrow(/signature/);
    expect(() => verifyManifest(manifest("9.0.0"), "")).toThrow(/publisher key/);
  });

  it("reports availability, refuses tampered manifests and checks the download hash", async () => {
    expect((await checkForUpdate({ publicKey })).status).toBe("not_configured");
    fs.writeFileSync(path.join(process.env.MEADOW_HOME!, "config.json"), JSON.stringify({ updates: { url: "https://releases.example.com/manifest.json", check: true } }));
    resetConfigCache();
    const available = await checkForUpdate({ publicKey, fetcher: fetcher(manifest("99.0.0")) });
    expect(available).toMatchObject({ status: "available", latest: "99.0.0", sha256 });
    expect((await checkForUpdate({ publicKey, fetcher: fetcher(manifest("0.0.1")) })).status).toBe("up_to_date");
    expect(await checkForUpdate({ publicKey, fetcher: fetcher({ ...manifest("99.0.0"), version: "99.0.1" }) })).toMatchObject({ status: "error", error: expect.stringMatching(/signature/) });
    if (available.status !== "available") throw new Error("expected an update");
    const file = await downloadUpdate(available, fetcher(null));
    expect(fs.readFileSync(file, "utf8")).toBe("release-bytes");
    await expect(downloadUpdate({ ...available, sha256: "0".repeat(64) }, fetcher(null))).rejects.toThrow(/checksum/);
  });
});

