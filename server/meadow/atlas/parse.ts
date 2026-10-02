/** Lightweight, dependency-free extractors. They favour recall on common patterns over full parsing. */

export type Symbol = { name: string; kind: "function" | "class"; line: number; endLine: number; exported: boolean; body: string };
export type Route = { method: string; path: string; line: number };

const LANG: Record<string, RegExp[]> = {
  js: [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*(export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(:[^=]+)?=>/,
    /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s+(public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(:\s*[^{]+)?\{\s*$/,
  ],
  py: [/^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, /^(\s*)class\s+([A-Za-z_]\w*)/],
  go: [/^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, /^type\s+([A-Za-z_]\w*)\s+struct/],
  java: [/^\s*(public|private|protected)?\s*(static\s+)?[\w<>[\],\s]+\s+([a-zA-Z_]\w*)\s*\([^)]*\)\s*(throws [\w.,\s]+)?\{/, /^\s*(public\s+)?(abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/],
};

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "else", "do", "try", "new", "typeof", "await"]);

export function langOf(path: string): keyof typeof LANG | null {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return "js";
  if (/\.py$/.test(path)) return "py";
  if (/\.go$/.test(path)) return "go";
  if (/\.(java|kt)$/.test(path)) return "java";
  return null;
}

/** Find function/class definitions and approximate their extent by indentation or brace depth. */
export function extractSymbols(path: string, text: string): Symbol[] {
  const lang = langOf(path);
  if (!lang) return [];
  const lines = text.split("\n");
  const found: Array<Omit<Symbol, "endLine" | "body">> = [];
  lines.forEach((line, index) => {
    for (const pattern of LANG[lang]) {
      const match = line.match(pattern);
      if (!match) continue;
      let name = "";
      let kind: Symbol["kind"] = "function";
      if (lang === "js") {
        if (/class\s/.test(line) && pattern === LANG.js[2]) { name = match[4]; kind = "class"; }
        else if (pattern === LANG.js[0]) name = match[4];
        else if (pattern === LANG.js[1]) name = match[3];
        else name = match[2];
      } else if (lang === "py") {
        if (pattern === LANG.py[1]) { name = match[2]; kind = "class"; } else name = match[3];
      } else if (lang === "go") {
        if (pattern === LANG.go[1]) { name = match[1]; kind = "class"; } else name = match[2];
      } else {
        if (pattern === LANG.java[1]) { name = match[3]; kind = "class"; } else name = match[3];
      }
      if (!name || KEYWORDS.has(name)) continue;
      found.push({ name, kind, line: index + 1, exported: /^\s*export\s/.test(line) || (lang === "go" && /^[A-Z]/.test(name)) || (lang === "py" && !name.startsWith("_")) });
      break;
    }
  });
  return found.map((symbol, i) => {
    const start = symbol.line - 1;
    let end = Math.min(lines.length, (found[i + 1]?.line ?? lines.length + 1) - 1);
    if (lang === "py") {
      const indent = lines[start].match(/^\s*/)![0].length;
      let j = start + 1;
      while (j < lines.length && (lines[j].trim() === "" || lines[j].match(/^\s*/)![0].length > indent)) j++;
      end = j;
    } else {
      let depth = 0;
      let opened = false;
      for (let j = start; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") { depth++; opened = true; }
          else if (ch === "}") depth--;
        }
        if (opened && depth <= 0) { end = j + 1; break; }
        if (!opened && j > start + 3) break;
      }
    }
    end = Math.max(end, symbol.line);
    return { ...symbol, endLine: end, body: lines.slice(start, Math.min(end, start + 120)).join("\n") };
  });
}

export function extractImports(path: string, text: string): string[] {
  const out = new Set<string>();
  const lang = langOf(path);
  if (lang === "js") {
    for (const match of text.matchAll(/(?:import\s[^'"]*from\s*|import\s*\(\s*|require\(\s*|export\s[^'"]*from\s*)['"]([^'"]+)['"]/g)) out.add(match[1]);
  } else if (lang === "py") {
    for (const match of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) out.add(match[1] ?? match[2]);
  } else if (lang === "go") {
    for (const match of text.matchAll(/^\s*(?:import\s+)?"([^"]+)"/gm)) out.add(match[1]);
  }
  return Array.from(out);
}

const ROUTE_PATTERNS: RegExp[] = [
  /\b(?:app|router|server|api|route[rs]?)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi,
  /@(?:app|router|api)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gi,
  /@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*)?"([^"]+)"/g,
  /@(Get|Post|Put|Patch|Delete)\(\s*['"]([^'"]*)['"]\s*\)/g,
  /HandleFunc\(\s*"([^"]+)"/g,
];

export function extractRoutes(text: string): Route[] {
  const routes: Route[] = [];
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  ROUTE_PATTERNS.forEach((pattern, i) => {
    for (const match of text.matchAll(pattern)) {
      if (i === 4) routes.push({ method: "ANY", path: match[1], line: lineOf(match.index ?? 0) });
      else routes.push({ method: match[1].toUpperCase(), path: match[2].startsWith("/") ? match[2] : `/${match[2]}`, line: lineOf(match.index ?? 0) });
    }
  });
  return routes;
}

export function extractTables(text: string): Array<{ name: string; columns: string[]; ddl: string }> {
  const tables: Array<{ name: string; columns: string[]; ddl: string }> = [];
  for (const match of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?(\w+)[`"\]]?\s*\(([\s\S]*?)\);/gi)) {
    const columns = match[2].split(",").map(part => part.trim().split(/\s+/)[0]?.replace(/[`"[\]]/g, "")).filter(column => column && !/^(primary|foreign|unique|constraint|key|check|index)$/i.test(column));
    tables.push({ name: match[1].toLowerCase(), columns, ddl: match[0].slice(0, 2000) });
  }
  for (const match of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    tables.push({ name: match[1].toLowerCase(), columns: match[2].split("\n").map(line => line.trim().split(/\s+/)[0]).filter(column => column && !column.startsWith("@") && !column.startsWith("//")), ddl: match[0].slice(0, 2000) });
  }
  return tables;
}

/** Table names referenced by SQL or ORM calls in a block of code, with read/write intent. */
export function tableRefs(text: string, known: Set<string>): Array<{ table: string; write: boolean }> {
  const refs = new Map<string, boolean>();
  const add = (name: string, write: boolean) => {
    const table = name.toLowerCase();
    if (known.has(table)) refs.set(table, refs.get(table) || write);
  };
  for (const match of text.matchAll(/\b(?:from|join)\s+[`"]?(\w+)/gi)) add(match[1], false);
  for (const match of text.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+[`"]?(\w+)/gi)) add(match[1], true);
  for (const match of text.matchAll(/\.(?:from|table)\(\s*['"`](\w+)['"`]\)/g)) add(match[1], false);
  for (const match of text.matchAll(/prisma\.(\w+)\.(create|update|upsert|delete)/g)) add(match[1], true);
  for (const match of text.matchAll(/prisma\.(\w+)\.(find\w*|count|aggregate)/g)) add(match[1], false);
  return Array.from(refs, ([table, write]) => ({ table, write }));
}

export function parseOpenApi(text: string): Array<{ method: string; path: string; summary: string }> {
  const ops: Array<{ method: string; path: string; summary: string }> = [];
  try {
    const spec = JSON.parse(text) as { paths?: Record<string, Record<string, { summary?: string; operationId?: string }>> };
    for (const [route, methods] of Object.entries(spec.paths ?? {})) for (const [method, op] of Object.entries(methods)) if (/^(get|post|put|patch|delete)$/i.test(method)) ops.push({ method: method.toUpperCase(), path: route, summary: op.summary ?? op.operationId ?? "" });
    return ops;
  } catch {
    // YAML: indentation-based scan of the `paths:` block.
  }
  const lines = text.split("\n");
  const start = lines.findIndex(line => /^paths:\s*$/.test(line));
  if (start < 0) return ops;
  let route = "";
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const routeMatch = line.match(/^ {2}['"]?(\/[^'":]*)['"]?:\s*$/);
    if (routeMatch) { route = routeMatch[1]; continue; }
    const methodMatch = line.match(/^ {4}(get|post|put|patch|delete):\s*$/i);
    if (methodMatch && route) {
      const summary = lines.slice(i + 1, i + 6).map(next => next.match(/^\s+(?:summary|operationId):\s*(.+)$/)?.[1]).find(Boolean) ?? "";
      ops.push({ method: methodMatch[1].toUpperCase(), path: route, summary: summary.replace(/^['"]|['"]$/g, "") });
    }
  }
  return ops;
}

export function parseTerraform(text: string): Array<{ type: string; name: string }> {
  return Array.from(text.matchAll(/^resource\s+"([\w-]+)"\s+"([\w-]+)"/gm), match => ({ type: match[1], name: match[2] }));
}

/** docker-compose services with depends_on, via indentation (no YAML dependency). */
export function parseCompose(text: string): Array<{ name: string; dependsOn: string[]; image: string | null }> {
  const lines = text.split("\n");
  const start = lines.findIndex(line => /^services:\s*$/.test(line));
  if (start < 0) return [];
  const services: Array<{ name: string; dependsOn: string[]; image: string | null }> = [];
  let current: { name: string; dependsOn: string[]; image: string | null } | null = null;
  let inDepends = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const service = line.match(/^ {2}([\w.-]+):\s*$/);
    if (service) { current = { name: service[1], dependsOn: [], image: null }; services.push(current); inDepends = false; continue; }
    if (!current) continue;
    const image = line.match(/^ {4}image:\s*(\S+)/);
    if (image) current.image = image[1];
    if (/^ {4}depends_on:/.test(line)) { inDepends = true; const inline = line.match(/\[(.*)\]/); if (inline) { current.dependsOn.push(...inline[1].split(",").map(item => item.trim().replace(/['"]/g, "")).filter(Boolean)); inDepends = false; } continue; }
    if (inDepends) {
      const dep = line.match(/^ {6}-?\s*([\w.-]+):?\s*$/);
      if (dep) current.dependsOn.push(dep[1]);
      else if (/^ {4}\S/.test(line)) inDepends = false;
    }
  }
  return services;
}

export function parseFrontMatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim();
    meta[kv[1]] = value.startsWith("[") ? value.slice(1, -1).split(",").map(item => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : value.replace(/^['"]|['"]$/g, "");
  }
  return { meta, body: match[2] };
}

export function markdownSections(text: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  let heading = "Overview";
  let buffer: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^#{1,3}\s+(.+)/);
    if (match) {
      if (buffer.join("").trim()) sections.push({ heading, body: buffer.join("\n").trim() });
      heading = match[1].trim();
      buffer = [];
    } else buffer.push(line);
  }
  if (buffer.join("").trim()) sections.push({ heading, body: buffer.join("\n").trim() });
  return sections;
}

/** Name variants used to spot references to a service in code and prose. */
export function nameVariants(name: string): string[] {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[-_\s]+/).filter(Boolean).map(word => word.toLowerCase());
  const base = words.filter(word => word !== "service" && word !== "svc");
  const variants = new Set([name.toLowerCase(), words.join("-"), words.join("_"), words.join(""), words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("").toLowerCase()]);
  if (base.length && base.length !== words.length) {
    variants.add(`${base.join("-")}-service`);
    variants.add(`${base.join("")}service`);
  }
  return Array.from(variants).filter(variant => variant.length >= 4);
}
