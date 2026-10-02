import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homePath, loadConfig } from "../config";

/**
 * Publisher key (Ed25519, SPKI PEM) that signs release manifests. Empty until the maintainer publishes
 * signed releases; until then update checks report "not configured" rather than trusting anything.
 */
export const UPDATE_PUBLIC_KEY = "";

export type UpdateManifest = { version: string; url: string; sha256: string; signature: string; notes?: string };
export type UpdateCheck =
  | { status: "not_configured"; current: string }
  | { status: "up_to_date"; current: string; latest: string }
  | { status: "available"; current: string; latest: string; notes: string | null; url: string; sha256: string }
  | { status: "error"; current: string; error: string };

export class UpdateError extends Error {}

export function currentVersion(): string {
  for (const candidate of [new URL("../package.json", import.meta.url), new URL("../../../package.json", import.meta.url)]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (pkg.version && pkg.name?.includes("meadow")) return pkg.version;
    } catch {
      // try the next layout (bundled dist vs. source)
    }
  }
  return "0.0.0";
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.replace(/^v/, "").split(/[.-]/).map(part => (/^\d+$/.test(part) ? Number(part) : part));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export const signedPayload = (manifest: Pick<UpdateManifest, "version" | "url" | "sha256">) => `meadow-update\n${manifest.version}\n${manifest.url}\n${manifest.sha256.toLowerCase()}`;

/** Throws unless the manifest is well-formed, points at HTTPS, and carries a valid publisher signature. */
export function verifyManifest(raw: unknown, publicKey = UPDATE_PUBLIC_KEY): UpdateManifest {
  const manifest = raw as Partial<UpdateManifest>;
  if (!manifest || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+([-.][\w.]+)?$/.test(manifest.version)) throw new UpdateError("Manifest has no valid version.");
  if (typeof manifest.url !== "string" || !manifest.url.startsWith("https://")) throw new UpdateError("Manifest download URL must be HTTPS.");
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw new UpdateError("Manifest has no valid sha256.");
  if (typeof manifest.signature !== "string") throw new UpdateError("Manifest is not signed.");
  if (!publicKey) throw new UpdateError("No publisher key is configured.");
  const ok = crypto.verify(null, Buffer.from(signedPayload(manifest as UpdateManifest)), crypto.createPublicKey(publicKey), Buffer.from(manifest.signature, "base64"));
  if (!ok) throw new UpdateError("Manifest signature is invalid. Refusing the update.");
  return manifest as UpdateManifest;
}

function manifestUrl(): string | null {
  const url = loadConfig().updates.url;
  if (!url) return null;
  if (!url.startsWith("https://")) throw new UpdateError("Update URL must be HTTPS.");
  return url;
}

export async function checkForUpdate(options: { publicKey?: string; fetcher?: typeof fetch } = {}): Promise<UpdateCheck> {
  const current = currentVersion();
  const publicKey = options.publicKey ?? UPDATE_PUBLIC_KEY;
  try {
    const url = manifestUrl();
    if (!url || !publicKey) return { status: "not_configured", current };
    const response = await (options.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) throw new UpdateError(`Update server answered ${response.status}.`);
    const manifest = verifyManifest(await response.json(), publicKey);
    if (compareVersions(manifest.version, current) <= 0) return { status: "up_to_date", current, latest: manifest.version };
    return { status: "available", current, latest: manifest.version, notes: manifest.notes?.slice(0, 2000) ?? null, url: manifest.url, sha256: manifest.sha256.toLowerCase() };
  } catch (error) {
    return { status: "error", current, error: (error as Error).message };
  }
}

/** Downloads the release and checks its sha256 against the signed manifest. Returns the verified file. */
export async function downloadUpdate(update: Extract<UpdateCheck, { status: "available" }>, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(update.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new UpdateError(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== update.sha256) throw new UpdateError("Downloaded file does not match the signed checksum. Nothing was installed.");
  const dir = homePath("updates");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `meadow-${update.latest}.tgz`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}
