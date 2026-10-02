import { describe, expect, it } from "vitest";
import { containsSecret, redact, registerSecret, tail } from "../../server/meadow/core/redact";

describe("redaction", () => {
  it.each([
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", "anthropic key"],
    ["sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX", "openai key"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github token"],
    ["AKIAABCDEFGHIJKLMNOP", "aws key"],
    ["freellmapi-0123456789abcdef", "freellmapi key"],
    ["123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ", "telegram token"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"],
  ])("scrubs %s (%s)", secret => {
    const out = redact(`token is ${secret} ok`);
    expect(out).not.toContain(secret);
    expect(containsSecret(`x ${secret}`)).toBe(true);
  });

  it("scrubs key=value assignments and bearer headers", () => {
    expect(redact("API_KEY=supersecretvalue123")).toBe("API_KEY=[REDACTED]");
    expect(redact('"password": "hunter2hunter2"')).toContain("[REDACTED]");
    expect(redact("Authorization: Bearer abcdefghijklmnop1234")).not.toContain("abcdefghijklmnop1234");
  });

  it("scrubs registered literal secrets", () => {
    registerSecret("my-very-own-secret-value");
    expect(redact("leak my-very-own-secret-value here")).toBe("leak [REDACTED] here");
  });

  it("leaves ordinary text alone", () => {
    const text = "npm test passed: 14 tests in 3.2s";
    expect(redact(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it("keeps the first error and the last lines when trimming output", () => {
    const lines = ["start", "Error: first failure here", ...Array.from({ length: 200 }, (_, i) => `line ${i}`)];
    const out = tail(lines.join("\n"), 10);
    expect(out).toContain("Error: first failure here");
    expect(out).toContain("line 199");
    expect(out).not.toContain("line 5\n");
  });
});
