import fs from "node:fs";
import path from "node:path";

export type VerifyKind = "typecheck" | "lint" | "test" | "build";
export type DetectedCommand = { kind: VerifyKind; cmd: string; source: string };
export type ProjectProfile = {
  root: string;
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  testFrameworks: string[];
  buildSystem: string | null;
  git: { repo: boolean; remote: string | null; branch: string | null };
  ci: string[];
  databases: string[];
  docker: { dockerfile: boolean; compose: boolean };
  mcpConfigs: string[];
  envExampleKeys: string[];
  commands: DetectedCommand[];
  markers: string[];
  /** Sub-folders with their own manifest (monorepo services, apps, packages). */
  packages: string[];
};

const read = (root: string, file: string): string | null => {
  try {
    const full = path.join(root, file);
    return fs.statSync(full).size > 512 * 1024 ? null : fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
};
const exists = (root: string, file: string) => fs.existsSync(path.join(root, file));
const json = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};
const add = (list: string[], value: string) => {
  if (!list.includes(value)) list.push(value);
};

const JS_FRAMEWORKS: Array<[string, string]> = [["next", "Next.js"], ["nuxt", "Nuxt"], ["@remix-run/react", "Remix"], ["@sveltejs/kit", "SvelteKit"], ["astro", "Astro"], ["vite", "Vite"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["@angular/core", "Angular"], ["express", "Express"], ["fastify", "Fastify"], ["@nestjs/core", "NestJS"], ["hono", "Hono"], ["@trpc/server", "tRPC"], ["electron", "Electron"], ["react-native", "React Native"]];
const JS_TESTS: Array<[string, string]> = [["vitest", "Vitest"], ["jest", "Jest"], ["mocha", "Mocha"], ["@playwright/test", "Playwright"], ["cypress", "Cypress"], ["ava", "AVA"]];
const JS_DBS: Array<[string, string]> = [["pg", "PostgreSQL"], ["postgres", "PostgreSQL"], ["@prisma/client", "Prisma"], ["prisma", "Prisma"], ["drizzle-orm", "Drizzle"], ["mysql2", "MySQL"], ["mongodb", "MongoDB"], ["mongoose", "MongoDB"], ["redis", "Redis"], ["ioredis", "Redis"], ["better-sqlite3", "SQLite"], ["@supabase/supabase-js", "Supabase"], ["typeorm", "TypeORM"], ["sequelize", "Sequelize"]];
const PY_FRAMEWORKS: Array<[RegExp, string]> = [[/\bdjango\b/i, "Django"], [/\bfastapi\b/i, "FastAPI"], [/\bflask\b/i, "Flask"], [/\bstreamlit\b/i, "Streamlit"]];
const PY_DBS: Array<[RegExp, string]> = [[/psycopg/i, "PostgreSQL"], [/sqlalchemy/i, "SQLAlchemy"], [/pymongo/i, "MongoDB"], [/\bredis\b/i, "Redis"], [/mysqlclient|pymysql/i, "MySQL"]];

const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "setup.py", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json"];
const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "target", "out", "coverage", "venv", ".venv", "__pycache__", "tmp", "fixtures", "examples", "docs"]);

/** First- and second-level folders that hold a manifest, e.g. services/payments or apps/web. Bounded so huge trees stay fast. */
function packageDirs(root: string): string[] {
  const found: string[] = [];
  const children = (dir: string) => {
    try {
      return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)).map(entry => path.join(dir, entry.name)).slice(0, 100);
    } catch {
      return [];
    }
  };
  const hasManifest = (dir: string) => MANIFESTS.some(file => exists(root, path.join(dir, file)));
  for (const first of children("")) {
    if (hasManifest(first)) found.push(first);
    else for (const second of children(first)) if (hasManifest(second)) found.push(second);
    if (found.length >= 60) break;
  }
  return found;
}

/**
 * Adds languages, frameworks, test runners and databases found in one folder. Verify commands come only from the
 * root, because they run from the project root; `prefix` is the folder relative to it ("" for the root).
 */
function scanManifests(root: string, prefix: string, profile: ProjectProfile): boolean {
  const commands: DetectedCommand[] = [];
  const before = profile.markers.length;
  const mark = (file: string) => exists(root, file) && (profile.markers.push(prefix ? path.join(prefix, file).split(path.sep).join("/") : file), true);
  const pkg = json<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string }>(read(root, "package.json"));
  if (pkg) {
    mark("package.json");
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    add(profile.languages, deps.typescript || exists(root, "tsconfig.json") ? "TypeScript" : "JavaScript");
    for (const [dep, name] of JS_FRAMEWORKS) if (deps[dep]) add(profile.frameworks, name);
    for (const [dep, name] of JS_TESTS) if (deps[dep]) add(profile.testFrameworks, name);
    for (const [dep, name] of JS_DBS) if (deps[dep]) add(profile.databases, name);
    if (!prefix || !profile.packageManager) profile.packageManager = pkg.packageManager?.split("@")[0] ?? (exists(root, "pnpm-lock.yaml") ? "pnpm" : exists(root, "yarn.lock") ? "yarn" : exists(root, "bun.lockb") || exists(root, "bun.lock") ? "bun" : "npm");
    const run = (script: string) => (profile.packageManager === "npm" ? `npm run ${script}` : `${profile.packageManager} ${script}`);
    const scripts = pkg.scripts ?? {};
    const pick = (kind: VerifyKind, names: string[]) => {
      const name = names.find(candidate => scripts[candidate] && !/watch|--watch|serve|dev\b/.test(scripts[candidate]));
      if (name) commands.push({ kind, cmd: kind === "test" && profile.testFrameworks.includes("Vitest") && !/run\b/.test(scripts[name]) && /^vitest\s*$/.test(scripts[name].trim()) ? `${run(name)} -- --run` : run(name), source: `package.json scripts.${name}` });
      return Boolean(name);
    };
    if (!pick("typecheck", ["typecheck", "type-check", "check-types", "tsc", "check"]) && deps.typescript && exists(root, "tsconfig.json")) commands.push({ kind: "typecheck", cmd: "npx tsc --noEmit", source: "tsconfig.json" });
    pick("lint", ["lint"]);
    if (scripts.test && !/no test specified/.test(scripts.test)) pick("test", ["test"]);
    if (pick("build", ["build"]) && (!prefix || !profile.buildSystem)) profile.buildSystem = profile.frameworks.includes("Vite") ? "Vite" : profile.frameworks.includes("Next.js") ? "Next.js" : "package.json build script";
  }
  const pyproject = read(root, "pyproject.toml");
  const requirements = read(root, "requirements.txt");
  if (pyproject || requirements || mark("setup.py")) {
    if (pyproject) mark("pyproject.toml");
    if (requirements) mark("requirements.txt");
    add(profile.languages, "Python");
    const text = `${pyproject ?? ""}\n${requirements ?? ""}`;
    for (const [pattern, name] of PY_FRAMEWORKS) if (pattern.test(text)) add(profile.frameworks, name);
    for (const [pattern, name] of PY_DBS) if (pattern.test(text)) add(profile.databases, name);
    profile.packageManager ??= exists(root, "uv.lock") ? "uv" : exists(root, "poetry.lock") ? "poetry" : "pip";
    if (/pytest/i.test(text) || exists(root, "pytest.ini") || exists(root, "tests")) {
      add(profile.testFrameworks, "pytest");
      commands.push({ kind: "test", cmd: profile.packageManager === "uv" ? "uv run pytest -q" : profile.packageManager === "poetry" ? "poetry run pytest -q" : "python -m pytest -q", source: "pytest" });
    }
    if (/\bmypy\b/i.test(text)) commands.push({ kind: "typecheck", cmd: "mypy .", source: "mypy" });
    if (/\bruff\b/i.test(text)) commands.push({ kind: "lint", cmd: "ruff check .", source: "ruff" });
  }
  if (mark("go.mod")) {
    add(profile.languages, "Go");
    profile.buildSystem ??= "go build";
    commands.push({ kind: "build", cmd: "go build ./...", source: "go.mod" }, { kind: "test", cmd: "go test ./...", source: "go.mod" }, { kind: "lint", cmd: "go vet ./...", source: "go.mod" });
    add(profile.testFrameworks, "go test");
  }
  if (mark("Cargo.toml")) {
    add(profile.languages, "Rust");
    profile.packageManager ??= "cargo";
    profile.buildSystem ??= "cargo";
    commands.push({ kind: "build", cmd: "cargo build", source: "Cargo.toml" }, { kind: "test", cmd: "cargo test", source: "Cargo.toml" }, { kind: "lint", cmd: "cargo clippy -- -D warnings", source: "Cargo.toml" });
    add(profile.testFrameworks, "cargo test");
  }

  if (mark("pom.xml") || mark("build.gradle") || mark("build.gradle.kts")) {
    add(profile.languages, exists(root, "build.gradle.kts") || fs.existsSync(path.join(root, "src/main/kotlin")) ? "Kotlin" : "Java");
    profile.buildSystem ??= exists(root, "pom.xml") ? "Maven" : "Gradle";
    const wrapper = exists(root, "pom.xml") ? (exists(root, "mvnw") ? (process.platform === "win32" ? "mvnw.cmd" : "./mvnw") : "mvn") : exists(root, "gradlew") ? (process.platform === "win32" ? "gradlew.bat" : "./gradlew") : "gradle";
    commands.push({ kind: "test", cmd: `${wrapper} ${exists(root, "pom.xml") ? "-q test" : "test"}`, source: exists(root, "pom.xml") ? "pom.xml" : "build.gradle" });
  }
  if (mark("Gemfile")) add(profile.languages, "Ruby");
  if (mark("composer.json")) add(profile.languages, "PHP");
  if (!prefix) profile.commands.push(...commands);
  return profile.markers.length > before;
}

/** `.git` is a folder in a normal clone and a `gitdir: …` file in worktrees and submodules. */
function gitDirOf(root: string): string | null {
  const dotGit = path.join(root, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const target = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    return target ? path.resolve(root, target) : null;
  } catch {
    return null;
  }
}

/** Reads well-known marker files (never `.env`, only `.env.example` key names) and infers how the project is built and verified. */
export function detectProject(root: string): ProjectProfile {
  const profile: ProjectProfile = { root, languages: [], frameworks: [], packageManager: null, testFrameworks: [], buildSystem: null, git: { repo: false, remote: null, branch: null }, ci: [], databases: [], docker: { dockerfile: false, compose: false }, mcpConfigs: [], envExampleKeys: [], commands: [], markers: [], packages: [] };
  scanManifests(root, "", profile);
  for (const dir of packageDirs(root)) if (scanManifests(path.join(root, dir), dir, profile)) profile.packages.push(dir.split(path.sep).join("/"));
  const mark = (file: string) => exists(root, file) && (profile.markers.push(file), true);

  profile.docker = { dockerfile: mark("Dockerfile"), compose: mark("docker-compose.yml") || mark("docker-compose.yaml") || mark("compose.yaml") || mark("compose.yml") };
  const compose = read(root, "docker-compose.yml") ?? read(root, "docker-compose.yaml") ?? read(root, "compose.yaml") ?? "";
  for (const [pattern, name] of [[/image:\s*postgres/i, "PostgreSQL"], [/image:\s*(mysql|mariadb)/i, "MySQL"], [/image:\s*mongo/i, "MongoDB"], [/image:\s*redis/i, "Redis"]] as Array<[RegExp, string]>) if (pattern.test(compose)) add(profile.databases, name);
  if (exists(root, "prisma/schema.prisma")) add(profile.databases, "Prisma");

  if (exists(root, ".git")) {
    profile.git.repo = true;
    const gitDir = gitDirOf(root);
    const head = gitDir ? read(gitDir, "HEAD") : null;
    profile.git.branch = head?.match(/ref: refs\/heads\/(.+)/)?.[1]?.trim() ?? null;
    const remote = (gitDir ? (read(gitDir, "config") ?? read(path.join(gitDir, "..", ".."), "config")) : null)?.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] ?? null;
    profile.git.remote = remote ? remote.replace(/\/\/[^@/]+@/, "//") : null;
  }
  if (exists(root, ".github/workflows")) {
    try {
      if (fs.readdirSync(path.join(root, ".github/workflows")).some(file => /\.ya?ml$/.test(file))) profile.ci.push("GitHub Actions");
    } catch {
      // unreadable folder
    }
  }
  if (exists(root, ".gitlab-ci.yml")) profile.ci.push("GitLab CI");
  if (exists(root, ".circleci/config.yml")) profile.ci.push("CircleCI");
  if (exists(root, "Jenkinsfile")) profile.ci.push("Jenkins");
  if (exists(root, "playwright.config.ts") || exists(root, "playwright.config.js")) add(profile.testFrameworks, "Playwright");

  for (const file of [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json"]) if (exists(root, file)) profile.mcpConfigs.push(file);
  const envExample = read(root, ".env.example") ?? read(root, ".env.sample");
  if (envExample) profile.envExampleKeys = Array.from(envExample.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)).map(match => match[1]).slice(0, 50);
  return profile;
}

/** One line per finding, e.g. "TypeScript detected". */
export function profileLines(profile: ProjectProfile): string[] {
  const lines = [
    ...profile.languages.map(item => `${item} detected`),
    ...profile.frameworks.map(item => `${item} detected`),
    ...(profile.packageManager ? [`${profile.packageManager} package manager`] : []),
    ...profile.testFrameworks.map(item => `${item} tests`),
    ...profile.databases.map(item => `${item} detected`),
    ...(profile.git.repo ? [`Git repository${profile.git.branch ? ` (${profile.git.branch})` : ""}`] : []),
    ...profile.ci.map(item => `${item} detected`),
    ...(profile.docker.dockerfile ? ["Dockerfile"] : []),
    ...(profile.docker.compose ? ["Docker Compose"] : []),
    ...profile.mcpConfigs.map(item => `MCP config in ${item}`),
  ];
  return lines.length ? lines : ["No known project markers found"];
}
