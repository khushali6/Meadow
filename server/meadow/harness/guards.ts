import path from "node:path";
import { diffText, revertPaths, status, type StatusEntry } from "../core/git";
import { isInside } from "../core/paths";
import { redact } from "../core/redact";

const PROTECTED = [/^PLAN\.md$/, /^SPEC\.md$/, /^\.meadow\//];
const DEPENDENCY_FILES = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/;
const SECRET_FILES = /(^|\/)(\.env(\.[^/]*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials(\.json)?|\.npmrc|\.pypirc)$/;

export type GuardReport = {
  changed: StatusEntry[];
  escaped: string[];
  reverted: string[];
  dependencyChanges: string[];
  deletions: string[];
  secretFindings: string[];
  feedback: string;
  blocking: boolean;
};

const isExample = (file: string) => /\.(example|sample|template)$/.test(file);

export async function runGuards(cwd: string, baseSha: string): Promise<GuardReport> {
  const changed = await status(cwd);
  const report: GuardReport = { changed, escaped: [], reverted: [], dependencyChanges: [], deletions: [], secretFindings: [], feedback: "", blocking: false };
  const feedback: string[] = [];

  for (const entry of changed) {
    const file = entry.path;
    if (!isInside(cwd, path.join(cwd, file))) report.escaped.push(file);
    if (PROTECTED.some(pattern => pattern.test(file))) report.reverted.push(file);
    if (DEPENDENCY_FILES.test(file)) report.dependencyChanges.push(file);
    if (entry.code.includes("D")) report.deletions.push(file);
    if (SECRET_FILES.test(file) && !isExample(file) && !entry.code.includes("D")) report.secretFindings.push(`${file} looks like a credentials file`);
  }

  if (report.escaped.length) {
    report.blocking = true;
    await revertPaths(cwd, baseSha, report.escaped);
    feedback.push(`These paths resolve outside the project (symlink escape) and were reverted: ${report.escaped.join(", ")}. Never create symlinks that point outside the repository.`);
  }
  if (report.reverted.length) {
    await revertPaths(cwd, baseSha, report.reverted);
    feedback.push(`You edited files you must not touch; they were reverted: ${report.reverted.join(", ")}. Do not modify PLAN.md, SPEC.md or .meadow/.`);
  }

  const diff = await diffText(cwd, baseSha);
  const added = diff.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"));
  for (const line of added) {
    if (redact(line) !== line && !/process\.env|os\.environ|getenv|\$\{|<your|example|placeholder|xxx/i.test(line)) {
      report.secretFindings.push(redact(line).slice(0, 160));
      if (report.secretFindings.length >= 5) break;
    }
  }
  if (report.secretFindings.length) {
    report.blocking = true;
    feedback.push(`The diff appears to contain secrets, so it cannot be committed:\n${report.secretFindings.map(item => `- ${item}`).join("\n")}\nRemove them and read secrets from environment variables instead.`);
  }

  report.feedback = feedback.join("\n\n");
  return report;
}
