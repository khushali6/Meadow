import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache, saveConfig } from "../../server/meadow/config";
import { getDb } from "../../server/meadow/core/db";
import { assertSelectableEngine, doctorAll, effectiveDefaultEngine, engineInfo, EngineUnavailableError, selectableEngines } from "../../server/meadow/engines/registry";
import { handleText } from "../../server/meadow/intake/conversation";
import { createProject, getProject, migrateUnavailableEngines, updateProject } from "../../server/meadow/projects";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
const savedEngine = process.env.MEADOW_ENGINE;
beforeEach(() => {
  env = tempHome();
  delete process.env.MEADOW_ENGINE;
  resetConfigCache();
});
afterEach(() => {
  if (savedEngine === undefined) delete process.env.MEADOW_ENGINE;
  else process.env.MEADOW_ENGINE = savedEngine;
  resetConfigCache();
  env.cleanup();
});

describe("engine availability", () => {
  it("lists Claude Code as coming soon and keeps it out of the selectable set", () => {
    expect(engineInfo().find(engine => engine.name === "claude_code")?.status).toBe("coming_soon");
    expect(selectableEngines()).not.toContain("claude_code");
    expect(selectableEngines()).toContain("cursor");
  });

  it("rejects Claude Code with a structured error", () => {
    try {
      assertSelectableEngine("claude_code");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineUnavailableError);
      expect((error as EngineUnavailableError).code).toBe("ENGINE_COMING_SOON");
    }
    expect(() => assertSelectableEngine("nope")).toThrow(/Unknown engine/);
  });

  it("refuses Claude Code for new and existing projects", async () => {
    await expect(createProject({ name: "blocked", engine: "claude_code" })).rejects.toThrow(/coming soon/);
    const project = await createProject({ name: "ok", engine: "fake" });
    expect(() => updateProject(project.id, { engine: "claude_code" })).toThrow(/coming soon/);
  });

  it("falls back when the configured default or MEADOW_ENGINE is coming soon", async () => {
    process.env.MEADOW_ENGINE = "claude_code";
    resetConfigCache();
    expect(effectiveDefaultEngine()).toBe("cursor");
    delete process.env.MEADOW_ENGINE;
    resetConfigCache();
    saveConfig({ engine: { default: "claude_code" } });
    expect(effectiveDefaultEngine()).toBe("cursor");
    const project = await createProject({ name: "defaulted" });
    expect(project.engine).toBe("cursor");
  });

  it("migrates projects that were already on Claude Code", async () => {
    const project = await createProject({ name: "legacy", engine: "fake" });
    getDb().run("UPDATE projects SET engine = 'claude_code' WHERE id = ?", project.id);
    const moved = migrateUnavailableEngines();
    expect(moved).toEqual([{ project: "legacy", from: "claude_code", to: "cursor" }]);
    expect(getProject(project.id).engine).toBe("cursor");
    expect(getDb().get<{ title: string }>("SELECT title FROM events WHERE project_id = ? AND type = 'guard'", project.id)?.title).toMatch(/Engine switched/);
  });

  it("answers /engine claude_code with coming soon", async () => {
    await createProject({ name: "chat", engine: "fake" });
    await handleText("telegram", "1", "/project chat");
    expect((await handleText("telegram", "1", "/engine claude_code")).text).toMatch(/coming soon/);
  });

  it("reports coming soon in doctor without probing the CLI", async () => {
    const report = (await doctorAll()).find(item => item.engine === "claude_code")!;
    expect(report.status).toBe("coming_soon");
    expect(report.checks[0].detail).toMatch(/coming soon/);
  });
});
