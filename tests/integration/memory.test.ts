import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../../server/meadow/config";
import { cosine, currentSpace, LOCAL_SPACE, localEmbed } from "../../server/meadow/memory/embeddings";
import { indexProject, memoryStatus, reembed, search } from "../../server/meadow/rag/index";
import { tempHome } from "../helpers";

let env: ReturnType<typeof tempHome>;
let server: http.Server | null = null;
let embedCalls = 0;
let down = false;

async function ollamaMock(dims = 8): Promise<string> {
  embedCalls = 0;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      if (down) {
        res.writeHead(503).end("down");
        return;
      }
      if (req.url?.endsWith("/embeddings")) {
        embedCalls++;
        const input = JSON.parse(body).input as string[];
        const data = input.map((text, index) => ({ index, embedding: Array.from(localEmbed(text).slice(0, dims)) }));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

function writeRepo(root: string) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "cart.ts"), `export function cartTotal(items: Array<{ price: number; qty: number }>) {\n  // sums the shopping cart line items including quantity\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n`);
  fs.writeFileSync(path.join(root, "src", "auth.ts"), `export async function verifySession(token: string) {\n  // checks the login session cookie and refreshes the jwt\n  if (!token) throw new Error("no session");\n  return decodeJwt(token);\n}\n`);
  fs.writeFileSync(path.join(root, ".env"), "SECRET_KEY=abcdefghijklmnopqrstuvwxyz123456\n");
}

beforeEach(() => {
  env = tempHome();
  down = false;
});
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  env.cleanup();
});

describe("local embeddings", () => {
  it("are deterministic, normalised and rank related text higher", () => {
    const a = localEmbed("cartTotal sums the shopping cart");
    expect(Array.from(a)).toEqual(Array.from(localEmbed("cartTotal sums the shopping cart")));
    expect(Math.hypot(...a)).toBeCloseTo(1, 5);
    expect(cosine(localEmbed("cart total"), a)).toBeGreaterThan(cosine(localEmbed("jwt session cookie"), a));
  });

  it("index and search the project without any provider, and never index .env", async () => {
    const root = path.join(env.root, "repo");
    writeRepo(root);
    const result = await indexProject(1, root);
    expect(result.space).toBe(LOCAL_SPACE.key);
    const hits = await search(1, "where is the shopping cart total computed", 3, "code");
    expect(hits[0].path).toBe("src/cart.ts");
    expect((await search(1, "SECRET_KEY", 5)).some(hit => hit.path === ".env")).toBe(false);
    expect(memoryStatus(1)).toMatchObject({ stale: 0, current: result.chunks });
  });
});

describe("embedding versioning", () => {
  it("marks chunks stale when the embedding model changes and re-embeds them atomically", async () => {
    const root = path.join(env.root, "repo");
    writeRepo(root);
    await indexProject(1, root);
    const baseUrl = await ollamaMock();
    saveConfig({ llm: { providers: { ollama: { baseUrl, embeddingModel: "nomic-embed-text" } } }, memory: { embeddings: "provider", embeddingProvider: "ollama" } });
    expect(currentSpace()?.key).toBe("provider:ollama:nomic-embed-text");

    const before = memoryStatus(1);
    expect(before.stale).toBe(before.chunks);
    const done = await reembed(1);
    expect(done).toMatchObject({ failed: false, updated: before.chunks, space: "provider:ollama:nomic-embed-text" });
    expect(memoryStatus(1).stale).toBe(0);
    expect((await search(1, "shopping cart total", 2, "code"))[0].path).toBe("src/cart.ts");

    saveConfig({ llm: { providers: { ollama: { embeddingModel: "mxbai-embed-large" } } } });
    expect(memoryStatus(1).stale).toBe(before.chunks);
    down = true;
    expect(await reembed(1)).toMatchObject({ failed: true, updated: 0 });
    expect(memoryStatus(1).spaces).toEqual([{ space: "provider:ollama:nomic-embed-text", chunks: before.chunks }]);
    expect((await search(1, "login session jwt", 2, "code"))[0].path).toBe("src/auth.ts");
  });

  it("refuses cloud embedding providers so memory stays local", () => {
    saveConfig({ llm: { provider: "openai" }, memory: { embeddings: "provider", embeddingProvider: "openai" } });
    expect(currentSpace()).toBeNull();
    expect(memoryStatus(1).blockedReason).toMatch(/stays on this machine/);
  });

  it("indexes with stale markers when the provider is down, and search still works", async () => {
    const root = path.join(env.root, "repo");
    writeRepo(root);
    const baseUrl = await ollamaMock();
    down = true;
    saveConfig({ llm: { providers: { ollama: { baseUrl } }, timeoutMs: 2000 }, memory: { embeddings: "provider", embeddingProvider: "ollama" } });
    const result = await indexProject(1, root);
    expect(result).toMatchObject({ embedded: false, space: null });
    expect(memoryStatus(1).stale).toBe(result.chunks);
    expect((await search(1, "cart total", 1, "code"))[0].path).toBe("src/cart.ts");
  });
});
