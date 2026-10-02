// Kept dependency-free and syntax-conservative so even an old Node can run it far enough to explain the problem.
const [major, minor] = process.versions.node.split(".").map(Number);
const supported = major >= 24 || (major === 22 && minor >= 16);
const install = "Install the current LTS from https://nodejs.org, or with a version manager: nvm install 24 / fnm install 24 / volta install node@24";

if (!supported) {
  console.error(
    [
      `Meadow needs Node.js 22.16+ or 24+ (found ${process.versions.node}).`,
      "It uses the built-in node:sqlite module with full-text search, which older versions (and Node 23) don't ship.",
      install,
    ].join("\n"),
  );
  process.exit(1);
}

process.removeAllListeners("warning");
process.on("warning", warning => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  console.error(`(node) ${warning.name}: ${warning.message}`);
});

const sqliteProblem = async (): Promise<string | null> => {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(text)");
    db.close();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const entry = "./meadow.js";
sqliteProblem()
  .then(problem => {
    if (problem) {
      console.error(
        [
          `This Node.js build can't run Meadow's database: ${problem}`,
          "Some Linux distribution packages build Node against a system SQLite without FTS5.",
          install,
        ].join("\n"),
      );
      process.exit(1);
    }
    return import(entry);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
