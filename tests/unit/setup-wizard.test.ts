import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify, parseParams, pickLocalModels, type LocalModel } from "../../server/meadow/setup/localModels";
import { installPlan } from "../../server/meadow/setup/install";
import { cloneRepository, locateRepository, parseRemote, placementFor } from "../../server/meadow/setup/locate";
import { saveProviderKey } from "../../server/meadow/setup/providers";
import { getSecret, resetConfigCache } from "../../server/meadow/config";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
const cwd = process.cwd();
beforeAll(() => {
  env = tempHome();
});
afterAll(() => {
  process.chdir(cwd);
  env.cleanup();
});

const GB = 1024 ** 3;
const ollama = (id: string, sizeGb: number | null, params: string | null, family: string | null, families: string[] = []): LocalModel => ({ id, sizeBytes: sizeGb === null ? null : sizeGb * GB, paramsB: parseParams(params) ?? parseParams(id), family, families });
// The models installed on the developer machine this was built against.
const INSTALLED = [
  ollama("strix-qwen32b:latest", 19.9, "32.8B", "qwen2"),
  ollama("qwen2.5-coder:32b", 19.9, "32.8B", "qwen2"),
  ollama("gemma4:12b", 7.6, "11.9B", "gemma4"),
  ollama("qwen2.5:14b", 9, "14.8B", "qwen2"),
  ollama("nomic-embed-text:latest", 0.3, "137M", "nomic-bert"),
  ollama("qwen2.5-coder:32b-128k", 19.9, "32.8B", "qwen2"),
  ollama("llama3.1:8b", 4.9, "8.0B", "llama"),
  ollama("x/flux2-klein:latest", 5.7, null, null),
  ollama("phi3:latest", 2.2, "3.8B", "phi3"),
  ollama("qwen2.5vl:7b", 6, "8.3B", "qwen25vl"),
  ollama("moondream:latest", 1.7, "1B", "phi2", ["phi2", "clip"]),
  ollama("llava:13b", 8, "13B", "llama", ["llama", "clip"]),
  ollama("deepseek-coder:6.7b", 3.8, "7B", "llama"),
];

describe("local model choice", () => {
  it("parses parameter counts from details and tags", () => {
    expect([parseParams("32.8B"), parseParams("137M"), parseParams("qwen2.5:14b"), parseParams("mixtral:8x7b"), parseParams("latest")]).toEqual([32.8, 0.137, 14, 56, null]);
  });

  it("separates chat, embedding, vision and image models", () => {
    const kinds = Object.fromEntries(INSTALLED.map(model => [model.id, classify(model)]));
    expect(kinds).toMatchObject({ "nomic-embed-text:latest": "embedding", "x/flux2-klein:latest": "image", "qwen2.5vl:7b": "vision", "moondream:latest": "vision", "llava:13b": "vision", "qwen2.5:14b": "chat", "strix-qwen32b:latest": "chat" });
  });

  it("picks the strongest known instruct model that fits in memory, plus the embedding model", () => {
    const big = pickLocalModels(INSTALLED, 64 * GB);
    expect(big).toMatchObject({ chat: "qwen2.5-coder:32b", embedding: "nomic-embed-text:latest" });
    expect(big.reason).toContain("64 GB");
    expect(pickLocalModels(INSTALLED, 32 * GB).chat).toBe("qwen2.5:14b");
    expect(pickLocalModels(INSTALLED, 16 * GB).chat).toBe("qwen2.5:14b");
    expect(pickLocalModels(INSTALLED, 12 * GB).chat).toBe("llama3.1:8b");
    expect(pickLocalModels(INSTALLED.filter(model => classify(model) !== "chat"), 64 * GB)).toMatchObject({ chat: null, embedding: "nomic-embed-text:latest" });
    expect(pickLocalModels([], 16 * GB)).toMatchObject({ chat: null, reason: "No models installed yet. Install an instruction-tuned chat model such as qwen2.5:7b." });
  });

  it("ranks LM Studio ids that carry no metadata by name", () => {
    const pick = pickLocalModels([{ id: "qwen2.5-7b-instruct", sizeBytes: null, paramsB: 7, family: null, families: [] }, { id: "text-embedding-nomic-embed-text-v1.5", sizeBytes: null, paramsB: null, family: null, families: [] }], 16 * GB);
    expect(pick).toMatchObject({ chat: "qwen2.5-7b-instruct", embedding: "text-embedding-nomic-embed-text-v1.5" });
  });
});

describe("provider keys", () => {
  it("saves only the provider's own secret and rejects junk", () => {
    saveProviderKey("freellmapi", "  fla-test-key-123456  ");
    expect(getSecret("FREELLMAPI_API_KEY")).toBe("fla-test-key-123456");
    expect(() => saveProviderKey("ollama", "whatever-key")).toThrow(/doesn't use a key/);
    expect(() => saveProviderKey("openai", "short")).toThrow();
    expect(() => saveProviderKey("openai", "has space in it")).toThrow();
  });
});

describe("finding a repository by name", () => {
  it("parses owner/repo and git URLs, and refuses option-like input", () => {
    expect(parseRemote("acme/payments")).toEqual({ url: "https://github.com/acme/payments.git", slug: "payments", github: true });
    expect(parseRemote("https://gitlab.com/group/sub/app.git")).toEqual({ url: "https://gitlab.com/group/sub/app.git", slug: "app", github: false });
    expect(parseRemote("git@github.com:acme/api.git")).toMatchObject({ slug: "api", github: true });
    expect(parseRemote("--upload-pack=evil")).toBeNull();
    expect(parseRemote("https://user:pass@github.com/a/b")).toBeNull();
    expect(parseRemote("file:///etc")).toBeNull();
    expect(parseRemote("acmepay")).toBeNull();
  });

  it("finds a repository under the projects folder by name and says where new ones go", async () => {
    const projects = process.env.MEADOW_PROJECTS_DIR!;
    fs.mkdirSync(path.join(projects, "Acme-Pay", ".git"), { recursive: true });
    fs.mkdirSync(path.join(projects, "acmepay-docs"), { recursive: true });
    fs.writeFileSync(path.join(projects, "acmepay-docs", "package.json"), "{}");
    process.chdir(env.root);
    const result = await locateRepository("acmepay");
    expect(result.kind).toBe("name");
    expect(result.matches.map(match => [match.name, match.exact])).toEqual([["Acme-Pay", true], ["acmepay-docs", false]]);
    expect(result.placeDir).toBe(projects);
    expect(result.placeReason).toBe("MEADOW_PROJECTS_DIR is set");
    expect(result.create).toBeNull();
    const missing = await locateRepository("brand-new-thing");
    expect(missing.matches).toEqual([]);
    expect(missing.create).toEqual({ target: path.join(projects, "brand-new-thing"), exists: false });
  });

  it("finds repositories inside the folder Meadow was started from, and the folder itself", async () => {
    const parent = path.join(env.root, "launch");
    fs.mkdirSync(path.join(parent, "billing-api", ".git"), { recursive: true });
    process.chdir(parent);
    expect((await locateRepository("billing-api")).matches.map(match => match.path)).toEqual([fs.realpathSync(path.join(parent, "billing-api"))]);
    process.chdir(path.join(parent, "billing-api"));
    expect((await locateRepository("billing-api")).matches).toHaveLength(1);
    process.chdir(env.root);
  });

  it("treats paths as paths and offers to clone owner/repo into the projects folder", async () => {
    const direct = await locateRepository(env.root);
    expect(direct).toMatchObject({ kind: "path", create: null });
    const remote = await locateRepository("someone/widget");
    expect(remote.clone).toMatchObject({ url: "https://github.com/someone/widget.git", target: path.join(process.env.MEADOW_PROJECTS_DIR!, "widget") });
  });

  it("puts new repositories next to most of the user's existing ones when nothing is configured", () => {
    const saved = process.env.MEADOW_PROJECTS_DIR;
    delete process.env.MEADOW_PROJECTS_DIR;
    resetConfigCache();
    try {
      const counts = new Map([["/Users/x/work", 5], ["/Users/x/Desktop", 2]]);
      expect(placementFor(counts)).toEqual({ dir: "/Users/x/work", reason: "5 of your other repositories are there" });
      expect(placementFor(new Map()).reason).toMatch(/usual place for code/);
    } finally {
      process.env.MEADOW_PROJECTS_DIR = saved;
      resetConfigCache();
    }
  });

  it("clones a local bare repository without prompting, and explains failures", async () => {
    const origin = path.join(env.root, "origin.git");
    const work = path.join(env.root, "seed");
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, "README.md"), "hi\n");
    const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
    git(work, "init", "-q");
    git(work, "add", "-A", "-f");
    git(work, "commit", "-qm", "seed");
    execFileSync("git", ["clone", "-q", "--bare", work, origin]);
    await expect(cloneRepository("https://127.0.0.1:1/nobody/nothing.git", path.join(env.root, "fail"))).rejects.toThrow(/reach the git host|clone failed|private/);
    expect(fs.existsSync(path.join(env.root, "fail"))).toBe(false);
    await expect(cloneRepository("not a url", path.join(env.root, "x"))).rejects.toThrow(/can clone/);
  });
});

describe("baseline with missing tools", () => {
  it("recognises 'command not found' on every shell and never turns it into a fix-it task", async () => {
    const { isMissingTool } = await import("../../server/meadow/setup/verify");
    expect(isMissingTool(127, "sh: go: command not found")).toBe(true);
    expect(isMissingTool(1, "'go' is not recognized as an internal or external command,")).toBe(true);
    expect(isMissingTool(9009, "")).toBe(true);
    expect(isMissingTool(1, "FAIL src/app.test.ts")).toBe(false);
    const { initialPlanMarkdown } = await import("../../server/meadow/setup/onboarding");
    const project = { id: 1, name: "demo", path: env.root, engine: "cursor", description: "", screenshots: 0, base_branch: "main", created_at: "", updated_at: "" };
    const profile = { languages: ["Go"], frameworks: [], databases: [], packageManager: null, packages: [], testFrameworks: [], commands: [], git: { repo: false, branch: null, remote: null }, envKeys: [], mcpConfigs: [] } as never;
    const analysis = { services: [], sharedTables: [], debt: [], hotspots: [], counts: { files: 0, tests: 0 } } as never;
    const plan = initialPlanMarkdown(project, profile, analysis, {
      at: "",
      results: [
        { kind: "build", cmd: "go build ./...", passed: false, exitCode: 127, durationMs: 5, output: "go: command not found", missingTool: true },
        { kind: "lint", cmd: "npm run lint", passed: false, exitCode: 1, durationMs: 5, output: "3 errors" },
      ],
    });
    expect(plan).toContain("Fix `npm run lint`");
    expect(plan).not.toContain("go build");
  });
});

describe("dependency installs", () => {
  it("plans per-package installs with the right tool and a project-local virtualenv", async () => {
    const root = path.join(env.root, "mono");
    const write = (file: string, text = "") => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    write("package.json", "{}");
    write("pnpm-lock.yaml");
    write("services/api/go.mod", "module api\n");
    write("services/ml/requirements.txt", "fastapi\n");
    write("apps/web/package.json", "{}");
    write("apps/web/package-lock.json", "{}");
    const steps = await installPlan(root);
    const lines = steps.map(step => `${step.dir || "."}: ${path.basename(step.program)} ${step.args.join(" ")}`);
    expect(lines).toContain(".: pnpm install --frozen-lockfile");
    expect(lines).toContain("apps/web: npm ci --no-audit --no-fund");
    expect(lines).toContain("services/api: go mod download");
    expect(lines.some(line => /^services\/ml: python3? -m venv \.venv$/.test(line))).toBe(true);
    const pip = steps.find(step => step.dir === "services/ml" && step.args.includes("pip"))!;
    expect(pip.program).toBe(path.join(root, "services/ml", ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"));
  });
});
