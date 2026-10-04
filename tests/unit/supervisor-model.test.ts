import { describe, expect, it } from "vitest";
import { pickSupervisorModel } from "../../server/meadow/harness/orchestrator";

describe("supervisor model choice", () => {
  it("keeps the configured model when installed, else picks a mid-size Qwen coder", () => {
    expect(pickSupervisorModel("qwen2.5-coder:7b", ["qwen2.5-coder:7b", "llama3.1:8b"])).toBe("qwen2.5-coder:7b");
    expect(pickSupervisorModel("qwen2.5-coder:7b", ["qwen2.5-coder:32b", "qwen2.5-coder:14b", "qwen2.5vl:7b", "llama3.1:8b"])).toBe("qwen2.5-coder:14b");
    expect(pickSupervisorModel("qwen2.5-coder:7b", ["qwen2.5:14b", "qwen2.5vl:3b", "mistral:7b"])).toBe("qwen2.5:14b");
    expect(pickSupervisorModel("qwen2.5-coder:7b", ["mistral:7b"])).toBe("qwen2.5-coder:7b");
    expect(pickSupervisorModel("qwen2.5-coder:7b", [])).toBe("qwen2.5-coder:7b");
  });
});
