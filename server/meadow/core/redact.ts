const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]"],
  [/\bfreellmapi-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\b(xox[abpors]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]"],
  [/((?:api[_-]?key|secret|token|password|passwd|authorization)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi, "$1[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, "$1[REDACTED]"],
];

const extraSecrets = new Set<string>();

/** Register a literal secret value (e.g. a configured token) so it is always scrubbed. */
export function registerSecret(value: string | undefined | null) {
  if (value && value.length >= 6) extraSecrets.add(value);
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of Array.from(extraSecrets)) out = out.split(secret).join("[REDACTED]");
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function containsSecret(text: string): boolean {
  return redact(text) !== text;
}

/** Keep the first error-looking line plus the last lines, bounded in size. */
export function tail(text: string, maxLines = 60, maxChars = 6000): string {
  const lines = text.replace(/\r/g, "").split("\n");
  let out: string;
  if (lines.length <= maxLines) {
    out = lines.join("\n");
  } else {
    const firstError = lines.findIndex(line => /error|fail|exception|traceback/i.test(line));
    const last = lines.slice(-maxLines);
    const head = firstError >= 0 && firstError < lines.length - maxLines ? [lines[firstError], "…"] : ["…"];
    out = [...head, ...last].join("\n");
  }
  if (out.length > maxChars) out = "…" + out.slice(-maxChars);
  return redact(out);
}
