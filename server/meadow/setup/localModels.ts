import os from "node:os";

export type LocalModel = { id: string; sizeBytes: number | null; paramsB: number | null; family: string | null; families: string[] };
export type ModelKind = "chat" | "embedding" | "vision" | "image";
export type RankedModel = LocalModel & { kind: ModelKind; fits: boolean; score: number; note: string };
export type ModelPick = { chat: string | null; embedding: string | null; reason: string; ranked: RankedModel[] };

const GB = 1024 ** 3;

/** "32.8B" → 32.8, "137M" → 0.137, or from a tag like "qwen2.5:14b" / "mixtral:8x7b". */
export function parseParams(text: string | null | undefined): number | null {
  if (!text) return null;
  const moe = text.match(/(\d+)x(\d+(?:\.\d+)?)b/i);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const match = text.match(/(\d+(?:\.\d+)?)\s*([bm])\b/i) ?? text.match(/[:\-_](\d+(?:\.\d+)?)([bm])(?![a-z])/i);
  if (!match) return null;
  return match[2].toLowerCase() === "m" ? Number(match[1]) / 1000 : Number(match[1]);
}

/** Ollama's /api/tags carries sizes and parameter counts; LM Studio and others only list ids. */
export async function listLocalModels(provider: "ollama" | "lmstudio", baseUrl: string): Promise<LocalModel[] | null> {
  const fetchJson = async (url: string) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  if (provider === "ollama") {
    const tags = (await fetchJson(`${baseUrl.replace(/\/v1$/, "")}/api/tags`)) as { models?: Array<{ name: string; size?: number; details?: { parameter_size?: string; family?: string; families?: string[] | null } }> } | null;
    if (tags?.models) return tags.models.map(model => ({ id: model.name, sizeBytes: model.size ?? null, paramsB: parseParams(model.details?.parameter_size) ?? parseParams(model.name), family: model.details?.family ?? null, families: model.details?.families ?? [] }));
  }
  const listed = (await fetchJson(`${baseUrl}/models`)) as { data?: Array<{ id: string }> } | null;
  return listed?.data ? listed.data.map(model => ({ id: model.id, sizeBytes: null, paramsB: parseParams(model.id), family: null, families: [] })) : null;
}

const EMBEDDING = /embed|nomic-bert|\bbge\b|bge-|mxbai|minilm|\be5-|gte-|arctic-embed|snowflake/i;
const IMAGE = /flux|stable-diffusion|sdxl|^x\/|dall-?e|imagen/i;
const VISION = /llava|moondream|\bvl\b|vl:|-vl|vision|bakllava|clip/i;
/** Current, instruction-tuned families that follow JSON and multi-step prompts well. */
const STRONG = /^(qwen3|qwen2\.5|llama3\.[1-9]|llama3:|llama4|gemma[34]|mistral-(small|nemo|large)|deepseek-(r1|v3|coder-v2)|phi4|gpt-oss|command-r|granite3)/i;
const OLDER = /^(llama3|llama2|mistral|mixtral|phi3|gemma2?|deepseek-coder|codellama|starcoder|qwen2?)\b/i;

export function classify(model: LocalModel): ModelKind {
  const text = `${model.id} ${model.family ?? ""} ${model.families.join(" ")}`;
  if (EMBEDDING.test(text) || model.family === "bert") return "embedding";
  if (IMAGE.test(model.id) || (!model.family && model.paramsB === null && model.sizeBytes !== null)) return "image";
  if (VISION.test(text)) return "vision";
  return "chat";
}

/**
 * Picks the planning model: the strongest instruction-tuned chat model that fits comfortably in memory
 * (about 60% of RAM, leaving room for the OS, the engine and the dev server). Unknown fine-tunes rank below
 * the base families they come from, and long-context variants below their standard tag because they need more memory.
 */
export function pickLocalModels(models: LocalModel[], totalMemBytes = os.totalmem()): ModelPick {
  const budget = totalMemBytes * 0.6;
  const ranked: RankedModel[] = models.map(model => {
    const kind = classify(model);
    const estimated = model.sizeBytes ?? (model.paramsB ? model.paramsB * 0.6 * GB : null);
    const fits = estimated === null || estimated <= budget;
    const base = model.id.split(":")[0].split("/").pop() ?? model.id;
    const quality = STRONG.test(base) ? 1 : OLDER.test(base) ? 0.6 : 0.45;
    const size = Math.min(model.paramsB ?? 7, 40);
    const variant = /128k|256k|1m\b|-long/i.test(model.id) ? 0.9 : 1;
    const score = kind === "chat" && fits ? quality * Math.sqrt(size) * variant : -1;
    const note = kind !== "chat" ? `${kind} model` : !fits ? `needs about ${((estimated ?? 0) / GB).toFixed(0)} GB, more than this machine can spare` : quality === 1 ? "current instruct family" : quality === 0.6 ? "older family" : "unrecognised fine-tune";
    return { ...model, kind, fits, score, note };
  });
  ranked.sort((a, b) => b.score - a.score || (b.paramsB ?? 0) - (a.paramsB ?? 0));
  const chat = ranked.find(model => model.kind === "chat" && model.score > 0) ?? null;
  const embedding = ranked.filter(model => model.kind === "embedding").sort((a, b) => Number(/nomic/i.test(b.id)) - Number(/nomic/i.test(a.id)))[0] ?? null;
  const memory = `${Math.round(totalMemBytes / GB)} GB`;
  const reason = chat
    ? `${chat.id}: the strongest ${chat.note === "current instruct family" ? "current instruction-tuned" : "available"} chat model${chat.paramsB ? ` (${chat.paramsB}B)` : ""} that fits in ${memory} of memory${embedding ? `; ${embedding.id} for memory search` : ""}.`
    : `${models.length ? `No chat model here fits in ${memory} of memory or is usable for planning (only ${[...new Set(ranked.map(model => model.kind))].join(", ")} models).` : "No models installed yet."} Install an instruction-tuned chat model such as ${totalMemBytes >= 20 * GB ? "qwen2.5:14b" : "qwen2.5:7b"}.`;
  return { chat: chat?.id ?? null, embedding: embedding?.id ?? null, reason, ranked };
}
