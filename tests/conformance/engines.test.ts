import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../../server/meadow/engines/base";
import { parseClaudeLine } from "../../server/meadow/engines/claudeCode";
import { parseCursorLine } from "../../server/meadow/engines/cursor";

const fixtures = path.join(import.meta.dirname, "..", "fixtures", "sessions");
const replay = (file: string, parse: (line: string) => EngineEvent[]) => fs.readFileSync(path.join(fixtures, file), "utf8").split("\n").filter(Boolean).flatMap(parse);

/** Every adapter must map the same session to the same event shapes. */
const ADAPTERS: Array<[string, string, (line: string) => EngineEvent[]]> = [
  ["cursor", "cursor-success.jsonl", parseCursorLine],
  ["claude_code", "claude-success.jsonl", parseClaudeLine],
];

describe.each(ADAPTERS)("%s adapter conformance", (_name, fixture, parse) => {
  const events = replay(fixture, parse);

  it("starts with session_started carrying a session id", () => {
    expect(events[0].type).toBe("session_started");
    expect(events[0].sessionId).toBeTruthy();
  });

  it("ends with exactly one successful done event", () => {
    const done = events.filter(event => event.type === "done");
    expect(done).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({ type: "done", ok: true, reason: "completed" });
    expect(done[0].detail).toContain("src/index.js");
  });

  it("reports the file edit and the shell command", () => {
    expect(events.find(event => event.type === "file_edit")?.title).toContain("src/index.js");
    expect(events.find(event => event.type === "command_run")?.title).toBe("node src/index.js");
  });

  it("emits assistant messages", () => {
    expect(events.some(event => event.type === "message")).toBe(true);
  });

  it("only produces known event types", () => {
    const known = ["session_started", "thinking", "message", "tool_call", "file_edit", "command_run", "usage", "error", "done"];
    for (const event of events) expect(known).toContain(event.type);
  });

  it("ignores unknown and malformed lines instead of failing", () => {
    expect(parse('{"type":"brand_new_type"}')).toEqual([]);
    expect(parse("garbage {")).toEqual([]);
    expect(parse("")).toEqual([]);
  });
});

describe("usage reporting", () => {
  it("claude reports tokens and cost", () => {
    const usage = replay("claude-success.jsonl", parseClaudeLine).find(event => event.type === "usage");
    expect(usage?.usage).toEqual({ tokensIn: 1300, tokensOut: 300, costUsd: 0.0123 });
  });

  it("cursor maps an error result to a failed done", () => {
    const [done] = parseCursorLine('{"type":"result","subtype":"error","is_error":true,"result":"boom"}');
    expect(done).toMatchObject({ type: "done", ok: false, reason: "engine_error" });
  });
});
