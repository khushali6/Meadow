import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { confine, isInside, PathEscapeError, slugify, validProjectName } from "../../server/meadow/core/paths";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "meadow-paths-"));
const project = path.join(root, "project");
const outside = path.join(root, "outside");
fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(project, "escape-link"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("path confinement", () => {
  it("allows normal relative paths, including ones that do not exist yet", () => {
    expect(confine(project, "src/index.ts")).toBe(path.resolve(project, "src/index.ts"));
    expect(isInside(project, "new/dir/file.txt")).toBe(true);
  });

  it.each(["../outside/x", "../../etc/passwd", "src/../../outside", "/etc/passwd", "escape-link/secret.txt", "escape-link", "src/\0evil"])("rejects hostile path %s", hostile => {
    expect(() => confine(project, hostile)).toThrow(PathEscapeError);
  });

  it("treats the root itself as inside", () => {
    expect(isInside(project, ".")).toBe(true);
  });
});

describe("project names", () => {
  it("slugifies and validates", () => {
    expect(slugify("My Bakery Site!")).toBe("my-bakery-site");
    expect(slugify("../../etc")).toBe("etc");
    expect(validProjectName("bakery-site")).toBe(true);
    expect(validProjectName("../x")).toBe(false);
    expect(validProjectName("")).toBe(false);
  });
});
