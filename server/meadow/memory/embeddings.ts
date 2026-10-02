import { getLlm } from "../llm/client";
import { resolveProvider } from "../llm/catalog";
import { embeddingRoute } from "../llm/router";

/**
 * An embedding space identifies which model produced a vector. Vectors from different spaces are
 * never compared: search only uses stored vectors whose space matches the current one, and
 * anything else is reported as stale until it is re-embedded.
 */
export type EmbeddingSpace = { backend: "local" | "provider"; provider: string; model: string; version: string; key: string };

export const LOCAL_DIM = 512;
const LOCAL_VERSION = "2";
export const LOCAL_SPACE: EmbeddingSpace = { backend: "local", provider: "meadow", model: `hashed-${LOCAL_DIM}`, version: LOCAL_VERSION, key: `local:meadow:hashed-${LOCAL_DIM}:v${LOCAL_VERSION}` };

export function currentSpace(): EmbeddingSpace | null {
  const route = embeddingRoute();
  if (route.mode === "local") return LOCAL_SPACE;
  if (route.mode === "blocked") return null;
  const resolved = resolveProvider(route.id);
  return { backend: "provider", provider: route.id, model: resolved.embeddingModel, version: "1", key: `provider:${route.id}:${resolved.embeddingModel}` };
}

const splitIdentifiers = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./]+/g, " ").toLowerCase();

export function localTokens(text: string): string[] {
  const words = splitIdentifiers(text).split(/[^a-z0-9]+/).filter(word => word.length > 1 && word.length < 40);
  const out = words.slice();
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]}_${words[i + 1]}`);
  return out;
}

function bucket(token: string) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
  return { index: Math.abs(h) % LOCAL_DIM, sign: h & 1 ? 1 : -1 };
}

/** Stateless feature hashing with sublinear term frequency and identifier bigrams. Same input, same vector, on any machine. */
export function localEmbed(text: string): Float32Array {
  const counts = new Map<string, number>();
  for (const token of localTokens(text.slice(0, 8000))) counts.set(token, (counts.get(token) ?? 0) + 1);
  const vector = new Float32Array(LOCAL_DIM);
  for (const [token, count] of counts) {
    const { index, sign } = bucket(token);
    vector[index] += sign * (1 + Math.log(count)) * (token.includes("_") ? 0.6 : 1);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Vectors from the configured provider, in batches. Returns null when memory uses local embeddings
 * (callers compute those on demand) or the provider is unreachable (callers keep the previous
 * vectors and report them as stale).
 */
export async function providerEmbed(texts: string[]): Promise<{ vectors: number[][]; space: EmbeddingSpace } | null> {
  const space = currentSpace();
  if (!space || space.backend !== "provider" || !texts.length) return null;
  try {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) vectors.push(...(await getLlm().embed(texts.slice(i, i + 32).map(text => text.slice(0, 4000)))));
    if (vectors.length !== texts.length || vectors.some(vector => !vector?.length)) return null;
    return { vectors, space };
  } catch {
    return null;
  }
}

export async function embedQuery(text: string, space: EmbeddingSpace): Promise<ArrayLike<number> | null> {
  if (space.backend === "local") return localEmbed(text);
  const result = await providerEmbed([text]);
  return result && result.space.key === space.key ? result.vectors[0] : null;
}
