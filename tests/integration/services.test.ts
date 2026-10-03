import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig, setSecret } from "../../server/meadow/config";
import * as git from "../../server/meadow/core/git";
import { createProject } from "../../server/meadow/projects";
import { ensureGithubRepo, meadowCreatedRepo, pushBase } from "../../server/meadow/services/github";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
let server: http.Server;
let requests: Array<{ auth: string | undefined; body: Record<string, unknown> }>;
let respond: (body: Record<string, unknown>) => { status: number; data: Record<string, unknown> };

beforeEach(async () => {
  env = tempHome();
  requests = [];
  respond = body => {
    const bare = path.join(env.root, `${String(body.name)}.git`);
    execFileSync("git", ["init", "--bare", "--quiet", bare]);
    return { status: 201, data: { clone_url: bare, html_url: `https://github.com/me/${body.name}`, full_name: `me/${body.name}` } };
  };
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ auth: req.headers.authorization, body });
      const reply = respond(body);
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.data));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.MEADOW_GITHUB_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  delete process.env.MEADOW_GITHUB_API;
  await new Promise(resolve => server.close(resolve));
  env.cleanup();
});

describe("GitHub repository", () => {
  it("stays local without a token", async () => {
    const project = await createProject({ name: "no-token", engine: "fake" });
    expect(await ensureGithubRepo(project)).toMatchObject({ status: "skipped" });
    expect(requests).toHaveLength(0);
  });

  it("creates one private repository, adds origin, and leaves it alone next time", async () => {
    setSecret("GITHUB_TOKEN", "ghp_testtoken123456");
    const project = await createProject({ name: "Expense App", engine: "fake" });
    expect(await ensureGithubRepo(project)).toMatchObject({ status: "created" });
    expect(requests[0]).toMatchObject({ auth: "Bearer ghp_testtoken123456", body: { name: "expense-app", private: true } });
    expect((await git.git(project.path, "remote")).trim()).toBe("origin");
    expect(meadowCreatedRepo(project.id)?.fullName).toBe("me/expense-app");
    expect(await ensureGithubRepo(project)).toMatchObject({ status: "exists" });
    expect(requests).toHaveLength(1);
  });

  it("never touches a project that already has a remote", async () => {
    setSecret("GITHUB_TOKEN", "ghp_testtoken123456");
    const project = await createProject({ name: "has-remote", engine: "fake" });
    await git.git(project.path, "remote", "add", "origin", "https://github.com/someone/else.git");
    expect(await ensureGithubRepo(project)).toMatchObject({ status: "exists" });
    expect(requests).toHaveLength(0);
    expect(await pushBase(project)).toEqual({ pushed: false, detail: "" });
  });

  it("tries another name when the first is taken, and explains a token without the repo scope", async () => {
    setSecret("GITHUB_TOKEN", "ghp_testtoken123456");
    const original = respond;
    respond = body => (body.name === "taken" ? { status: 422, data: { message: "name already exists" } } : original(body));
    const project = await createProject({ name: "taken", engine: "fake" });
    expect(await ensureGithubRepo(project)).toMatchObject({ status: "created" });
    expect(requests.map(request => request.body.name)).toEqual(["taken", "taken-meadow"]);
    respond = () => ({ status: 403, data: { message: "Resource not accessible" } });
    const other = await createProject({ name: "scoped", engine: "fake" });
    expect((await ensureGithubRepo(other)).detail).toMatch(/repo" scope/);
  });

  it("respects the Settings switch", async () => {
    setSecret("GITHUB_TOKEN", "ghp_testtoken123456");
    saveConfig({ services: { github: { createRepo: false } } });
    const project = await createProject({ name: "switched-off", engine: "fake" });
    expect(await ensureGithubRepo(project)).toMatchObject({ status: "skipped" });
  });

  it("refuses an API override that isn't localhost, so the token can't leak", async () => {
    setSecret("GITHUB_TOKEN", "ghp_testtoken123456");
    process.env.MEADOW_GITHUB_API = "https://evil.example.com";
    const project = await createProject({ name: "leak", engine: "fake" });
    await expect(ensureGithubRepo(project)).rejects.toThrow(/localhost/);
  });

  it("pushes the base branch to the repository it created, without putting the token in the remote", async () => {
    setSecret("GITHUB_TOKEN", "ghp_testtoken123456");
    const project = await createProject({ name: "pusher", engine: "fake" });
    await ensureGithubRepo(project);
    const result = await pushBase(project);
    expect(result.pushed).toBe(true);
    const bare = meadowCreatedRepo(project.id)!.cloneUrl;
    expect(execFileSync("git", ["--git-dir", bare, "rev-parse", project.base_branch]).toString().trim()).toBe((await git.headSha(project.path)).trim());
    expect(fs.readFileSync(path.join(project.path, ".git", "config"), "utf8")).not.toContain("ghp_");
  });
});
