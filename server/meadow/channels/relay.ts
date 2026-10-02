import { deleteSecret, getSecret, loadConfig, setSecret } from "../config";
import { registerSecret } from "../core/redact";

/** Public URL of the relay for the official Meadow bot. Set this when you publish a build. */
export const HOSTED_RELAY_URL = "";

export class RelayError extends Error {
  constructor(readonly code: "NOT_CONFIGURED" | "INVALID_URL" | "UNREACHABLE" | "REJECTED", message: string) {
    super(message);
  }
}

const isLoopback = (host: string) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);

/** The relay must be HTTPS, or plain HTTP on this machine (for a relay you run locally). */
export function checkRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RelayError("INVALID_URL", "The relay URL isn't a valid URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw new RelayError("INVALID_URL", "The relay URL must use HTTPS (plain HTTP is only allowed on localhost).");
  if (url.username || url.password || url.search || url.hash) throw new RelayError("INVALID_URL", "The relay URL can't contain credentials, a query or a fragment.");
  return url.toString().replace(/\/$/, "");
}

export function relayUrl(): string | null {
  const raw = loadConfig().telegram.relayUrl || HOSTED_RELAY_URL;
  if (!raw) return null;
  try {
    return checkRelayUrl(raw);
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const base = relayUrl();
  if (!base) throw new RelayError("NOT_CONFIGURED", "This Meadow build has no hosted Telegram bot configured. Set a relay URL in Settings → Telegram, or use your own bot.");
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new RelayError("UNREACHABLE", `Couldn't reach the Meadow bot relay (${new URL(base).host}): ${(error as Error).message}`);
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, data };
}

export type RelayLink = { link: string; bot: string; expiresAt: string };

/** Registers this install with the relay (once) and returns a one-time t.me deep link carrying `code`. */
export async function requestLink(code: string): Promise<RelayLink> {
  let token = getSecret("TELEGRAM_RELAY_TOKEN");
  let reply = await post("/v1/link", { code }, token);
  if (reply.status === 401 && token) {
    deleteSecret("TELEGRAM_RELAY_TOKEN");
    token = undefined;
    reply = await post("/v1/link", { code });
  }
  if (reply.status !== 200) throw new RelayError("REJECTED", String(reply.data.error ?? reply.data.description ?? `Relay answered ${reply.status}`));
  if (typeof reply.data.deviceToken === "string") {
    setSecret("TELEGRAM_RELAY_TOKEN", reply.data.deviceToken);
    registerSecret(reply.data.deviceToken);
  }
  return { link: String(reply.data.link), bot: String(reply.data.bot), expiresAt: String(reply.data.expiresAt) };
}

export async function unlinkDevice() {
  const token = getSecret("TELEGRAM_RELAY_TOKEN");
  if (token) await post("/v1/unlink", {}, token).catch(() => null);
  deleteSecret("TELEGRAM_RELAY_TOKEN");
}
