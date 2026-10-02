import fs from "node:fs";
import path from "node:path";
import { getProject } from "../projects";
import { investigate, type Evidence, type Mode } from "./agents";
import { ACMEPAY_EVAL, type EvalCase } from "./demo";
import { llmAvailable } from "./llm";
import { allEmbeddings } from "./store";

export type ModeScore = { recall5: number; recall10: number; mrr: number; ndcg10: number; faithfulness: number; citationAccuracy: number; answerHit: number; latencyMs: number; p95Ms: number; tokens: number };
export type EvalReport = { project: string; cases: number; generatedAt: string; llm: boolean; vectorBackend: "gateway" | "hashed"; modes: Partial<Record<Mode, ModeScore>>; perCase: Array<{ id: string; type: string; mode: Mode; recall10: number; mrr: number; answerHit: number; faithfulness: number; ms: number }> };

export const EVAL_MODES: Mode[] = ["vector", "graph", "hybrid", "agentic"];

export function loadEvalCases(projectId: number): EvalCase[] {
  const file = path.join(getProject(projectId).path, ".atlas", "eval.json");
  try {
    const cases = JSON.parse(fs.readFileSync(file, "utf8")) as EvalCase[];
    if (Array.isArray(cases) && cases.every(c => c.question && Array.isArray(c.relevant))) return cases;
  } catch {
    // fall through
  }
  return getProject(projectId).name.startsWith("acmepay") ? ACMEPAY_EVAL : [];
}

/** Ranked, de-duplicated relevance list: a hit counts when its node key matches, or when it sits inside a relevant file. */
function judge(evidence: Evidence[], relevant: string[]): boolean[] {
  const found = new Set<string>();
  return evidence.map(e => {
    const match = relevant.find(key => !found.has(key) && (e.nodeKey === key || (key.startsWith("file:") && e.path === key.slice(5)) || (key.startsWith("doc:") && e.path === key.slice(4))));
    if (!match) return false;
    found.add(match);
    return true;
  });
}

const recallAt = (rels: boolean[], total: number, k: number) => (total ? rels.slice(0, k).filter(Boolean).length / total : 0);
const mrr = (rels: boolean[]) => {
  const first = rels.indexOf(true);
  return first < 0 ? 0 : 1 / (first + 1);
};
const ndcgAt = (rels: boolean[], total: number, k: number) => {
  const dcg = rels.slice(0, k).reduce((sum, rel, i) => sum + (rel ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(total, k) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return ideal ? dcg / ideal : 0;
};
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

export async function runEval(projectId: number, options: { modes?: Mode[]; onProgress?: (line: string) => void } = {}): Promise<EvalReport> {
  const cases = loadEvalCases(projectId);
  if (!cases.length) throw new Error("No benchmark found. Add .atlas/eval.json to the project (see `meadow atlas demo`).");
  const modes = options.modes ?? EVAL_MODES;
  const report: EvalReport = { project: getProject(projectId).name, cases: cases.length, generatedAt: new Date().toISOString(), llm: llmAvailable(), vectorBackend: allEmbeddings(projectId).length ? "gateway" : "hashed", modes: {}, perCase: [] };
  for (const mode of modes) {
    const rows: Array<ModeScore & { ms: number }> = [];
    for (const c of cases) {
      const started = performance.now();
      const result = await investigate(projectId, c.question, { mode, record: false, k: 10 });
      const ms = performance.now() - started;
      const rels = judge(result.evidence, c.relevant);
      const answer = result.answer.toLowerCase();
      const answerHit = c.answerHints.length ? c.answerHints.filter(hint => answer.includes(hint.toLowerCase())).length / c.answerHints.length : 1;
      const row = { recall5: recallAt(rels, c.relevant.length, 5), recall10: recallAt(rels, c.relevant.length, 10), mrr: mrr(rels), ndcg10: ndcgAt(rels, c.relevant.length, 10), faithfulness: result.verifier.faithfulness, citationAccuracy: result.verifier.citationAccuracy, answerHit, latencyMs: ms, p95Ms: ms, tokens: result.usage.contextTokens + result.usage.tokensIn + result.usage.tokensOut, ms };
      rows.push(row);
      report.perCase.push({ id: c.id, type: c.type, mode, recall10: round(row.recall10), mrr: round(row.mrr), answerHit: round(row.answerHit), faithfulness: round(row.faithfulness), ms: Math.round(ms) });
      options.onProgress?.(`${mode.padEnd(8)} ${c.id.padEnd(18)} recall@10 ${row.recall10.toFixed(2)}  mrr ${row.mrr.toFixed(2)}  answer ${row.answerHit.toFixed(2)}  ${Math.round(ms)}ms`);
    }
    const latencies = rows.map(r => r.ms).sort((a, b) => a - b);
    report.modes[mode] = {
      recall5: round(mean(rows.map(r => r.recall5))),
      recall10: round(mean(rows.map(r => r.recall10))),
      mrr: round(mean(rows.map(r => r.mrr))),
      ndcg10: round(mean(rows.map(r => r.ndcg10))),
      faithfulness: round(mean(rows.map(r => r.faithfulness))),
      citationAccuracy: round(mean(rows.map(r => r.citationAccuracy))),
      answerHit: round(mean(rows.map(r => r.answerHit))),
      latencyMs: Math.round(mean(latencies)),
      p95Ms: Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0),
      tokens: Math.round(mean(rows.map(r => r.tokens))),
    };
  }
  return report;
}

export function formatReport(report: EvalReport): string {
  const header = "| Mode | Recall@5 | Recall@10 | MRR | nDCG@10 | Answer hit | Faithfulness | Citation acc. | Latency (avg / p95) | Tokens |";
  const rows = (Object.entries(report.modes) as Array<[Mode, ModeScore]>).map(([mode, s]) => `| ${mode} | ${s.recall5.toFixed(2)} | ${s.recall10.toFixed(2)} | ${s.mrr.toFixed(2)} | ${s.ndcg10.toFixed(2)} | ${s.answerHit.toFixed(2)} | ${s.faithfulness.toFixed(2)} | ${s.citationAccuracy.toFixed(2)} | ${s.latencyMs} / ${s.p95Ms} ms | ${s.tokens} |`);
  return [`${report.project}: ${report.cases} questions · LLM ${report.llm ? "on" : "off (rule-based writer)"} · vectors ${report.vectorBackend}`, "", header, "|---|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}
