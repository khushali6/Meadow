import { describe, expect, it } from "vitest";
import { failureReason } from "../../server/meadow/engines/base";
import { parseClaudeLine } from "../../server/meadow/engines/claudeCode";
import { parseCodexLine } from "../../server/meadow/engines/codex";
import { parsePlainLine } from "../../server/meadow/engines/custom";
import { createGeminiParser } from "../../server/meadow/engines/gemini";

describe("engine failure classification", () => {
  it("stops on login and model problems instead of retrying", () => {
    expect(failureReason("Not logged in · Please run /login")).toBe("auth");
    expect(failureReason("Error: Invalid API key")).toBe("auth");
    expect(failureReason("There's an issue with the selected model (claude-opus-4-8[1m]). It may not exist or you may not have access to it.")).toBe("model_unavailable");
    expect(failureReason("model gpt-9 not found")).toBe("model_unavailable");
    expect(failureReason("npm test exited 1")).toBeNull();
  });

  it("maps Claude Code result errors to those reasons", () => {
    const login = parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" })).at(-1)!;
    expect(login).toMatchObject({ type: "done", ok: false, reason: "auth" });
    const model = parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "There's an issue with the selected model (claude-sonnet-4-6). It may not exist or you may not have access to it." })).at(-1)!;
    expect(model).toMatchObject({ ok: false, reason: "model_unavailable" });
  });
});

describe("codex exec --json parser", () => {
  it("turns thread, item and turn events into engine events", () => {
    const lines = [
      { type: "thread.started", thread_id: "th_1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i0", type: "reasoning", text: "**Planning**" } },
      { type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc 'npm test'", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "add" }], status: "completed" } },
      { type: "item.completed", item: { id: "i3", type: "agent_message", text: "Done. Added b.ts.\nDetails…" } },
      { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 150 } },
    ];
    const events = lines.flatMap(line => parseCodexLine(JSON.stringify(line)));
    expect(events.map(event => event.type)).toEqual(["session_started", "thinking", "command_run", "file_edit", "file_edit", "message", "usage", "done"]);
    expect(events[0].sessionId).toBe("th_1");
    expect(events[3].title).toBe("Edited src/a.ts");
    expect(events[4].title).toBe("Created src/b.ts");
    expect(events.at(-1)).toMatchObject({ ok: true, reason: "completed" });
  });

  it("reports failed turns with a reason", () => {
    expect(parseCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "401 Unauthorized" } }))[0]).toMatchObject({ type: "done", ok: false, reason: "auth" });
    expect(parseCodexLine("not json")).toEqual([]);
  });
});

describe("gemini stream-json parser", () => {
  it("buffers assistant deltas into one message per step", () => {
    const parse = createGeminiParser();
    const lines = [
      { type: "init", session_id: "s1", model: "gemini-2.5-pro" },
      { type: "message", role: "user", content: "build it" },
      { type: "message", role: "assistant", content: "I'll create ", delta: true },
      { type: "message", role: "assistant", content: "the file.", delta: true },
      { type: "tool_use", tool_name: "write_file", tool_id: "t1", parameters: { file_path: "src/index.js", content: "x" } },
      { type: "tool_result", tool_id: "t1", status: "success" },
      { type: "tool_use", tool_name: "run_shell_command", tool_id: "t2", parameters: { command: "npm test" } },
      { type: "message", role: "assistant", content: "All set.", delta: true },
      { type: "result", status: "success", stats: { input_tokens: 500, output_tokens: 80 } },
    ];
    const events = lines.flatMap(line => parse(JSON.stringify(line)));
    expect(events.map(event => event.type)).toEqual(["session_started", "message", "file_edit", "command_run", "message", "usage", "done"]);
    expect(events[1].title).toBe("I'll create the file.");
    expect(events[2].title).toBe("Edited src/index.js");
    expect(events.at(-1)).toMatchObject({ ok: true });
  });
});

describe("custom command output", () => {
  it("turns non-empty lines into messages and strips colour codes", () => {
    expect(parsePlainLine("\x1b[32mApplied edit to src/app.py\x1b[0m")).toEqual([{ type: "message", title: "Applied edit to src/app.py", detail: "Applied edit to src/app.py" }]);
    expect(parsePlainLine("   ")).toEqual([]);
  });
});
