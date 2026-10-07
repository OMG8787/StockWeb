// 評測結果 → Markdown 報告（純函式）。
import type { CheckResult, EvalCase } from "./types";

export interface EvalRecord {
  caseId: string;
  variant: string;
  model?: string;
  ok: boolean;
  latencyMs: number;
  failure?: string;
  rawAnswer?: string;
  finalAnswer?: string;
  checks: CheckResult[];
  judge?: { score: number; reason: string; by?: string };
  /** 回答後檢查（ask.ts finalizeAiAnswer）沒有一次通過時：重生／程式版／截斷修剪與原因 */
  postCheck?: { outcome: string; issues: string[] };
}

export interface CaseCapture {
  caseId: string;
  phase?: string;
  systemChars?: number;
  userChars?: number;
  /** 這題附給 AI 的參考資料（重新評分用；只存在 JSON，不進報告） */
  grounding?: string;
  /** 這題附了哪些資料區塊、組了哪些規則（run.ts describeRoute） */
  route?: { blocks: string[]; rules: string[] };
  error?: string;
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a / b) * 100)}%`);
const esc = (s: string) => s.replace(/\|/g, "／").replace(/\n+/g, " ");

export function renderReport(p: {
  date: string;
  startedAt: string;
  variants: string[];
  cases: EvalCase[];
  captures: CaseCapture[];
  records: EvalRecord[];
}): string {
  const { variants, records, cases, captures } = p;
  const L: string[] = [];
  L.push(`# AI 問答跨模型評測 ${p.date}`, "");
  L.push(`- 開始：${p.startedAt}（UTC）；題數 ${cases.length}；模型組：${variants.join("、")}`);
  L.push("- 主分數＝程式規則通過率（graders.ts）；LLM 評審只當參考。每題各模型拿到的系統提示詞與參考資料完全相同。");
  L.push("");

  // 總覽
  L.push("## 總覽", "", "| 模型組 | 實際模型 | 有回答 | 規則通過率 | 全部通過題數 | 平均延遲 | LLM 評審平均 |", "|---|---|---|---|---|---|---|");
  for (const v of variants) {
    const rs = records.filter((r) => r.variant === v);
    const ok = rs.filter((r) => r.ok);
    const checks = ok.flatMap((r) => r.checks);
    const allPass = ok.filter((r) => r.checks.every((c) => c.pass)).length;
    const models = [...new Set(ok.map((r) => r.model).filter(Boolean))].join("、") || "—";
    const lat = ok.length ? `${(ok.reduce((n, r) => n + r.latencyMs, 0) / ok.length / 1000).toFixed(1)}s` : "—";
    const js = ok.map((r) => r.judge?.score).filter((x): x is number => typeof x === "number");
    const judgeAvg = js.length ? (js.reduce((a, b) => a + b, 0) / js.length).toFixed(2) : "—";
    L.push(`| ${v} | ${models} | ${ok.length}/${rs.length} | ${pct(checks.filter((c) => c.pass).length, checks.length)}（${checks.filter((c) => c.pass).length}/${checks.length}） | ${allPass}/${ok.length} | ${lat} | ${judgeAvg} |`);
  }
  L.push("");

  // 各規則通過率
  const rules = [...new Set(records.flatMap((r) => r.checks.map((c) => c.rule)))];
  L.push("## 各規則通過率", "", `| 規則 | ${variants.join(" | ")} |`, `|---|${variants.map(() => "---").join("|")}|`);
  const ruleRows = rules.map((rule) => {
    const cells = variants.map((v) => {
      const cs = records.filter((r) => r.variant === v && r.ok).flatMap((r) => r.checks.filter((c) => c.rule === rule));
      return { pass: cs.filter((c) => c.pass).length, total: cs.length };
    });
    const fails = cells.reduce((n, c) => n + (c.total - c.pass), 0);
    return { rule, cells, fails };
  });
  ruleRows.sort((a, b) => b.fails - a.fails);
  for (const r of ruleRows) L.push(`| ${r.rule} | ${r.cells.map((c) => (c.total ? `${pct(c.pass, c.total)}（${c.pass}/${c.total}）` : "—")).join(" | ")} |`);
  L.push("");

  // 各題
  L.push("## 各題結果", "", `| 題目 | 時段 | 提示詞字數 | ${variants.join(" | ")} |`, `|---|---|---|${variants.map(() => "---").join("|")}|`);
  for (const c of cases) {
    const cap = captures.find((x) => x.caseId === c.id);
    const cells = variants.map((v) => {
      const r = records.find((x) => x.caseId === c.id && x.variant === v);
      if (!r) return "—";
      if (!r.ok) return `✗ ${esc((r.failure ?? "").slice(0, 30))}`;
      const n = r.checks.filter((x) => x.pass).length;
      return `${n}/${r.checks.length}${r.judge ? `（評審${r.judge.score}）` : ""}`;
    });
    const size = cap && !cap.error ? `${cap.systemChars}+${cap.userChars}` : `失敗：${esc(cap?.error ?? "")}`;
    L.push(`| ${c.id}：${esc(c.title)} | ${cap && !cap.error ? cap.phase : "—"} | ${size} | ${cells.join(" | ")} |`);
  }
  L.push("");

  // 失敗明細
  L.push("## 失敗明細（規則沒過的項目）", "");
  for (const c of cases) {
    const fails = records.filter((r) => r.caseId === c.id && (!r.ok || r.checks.some((x) => !x.pass)));
    if (fails.length === 0) continue;
    L.push(`### ${c.id}：${c.question}`, "");
    for (const r of fails) {
      if (!r.ok) {
        L.push(`- **${r.variant}** 沒有回答：${esc(r.failure ?? "")}`);
        continue;
      }
      for (const x of r.checks.filter((k) => !k.pass)) L.push(`- **${r.variant}**｜${x.rule}${x.detail ? `：${esc(x.detail)}` : ""}`);
      L.push(`  - 回答開頭：${esc((r.finalAnswer ?? "").slice(0, 160))}…`);
    }
    L.push("");
  }
  return L.join("\n");
}

/** 兩次評測（例如改提示詞前後）各模型各規則通過率的比較表。 */
export function renderComparison(p: {
  title: string;
  before: { label: string; records: EvalRecord[] };
  after: { label: string; records: EvalRecord[] };
  variants: string[];
}): string {
  const L: string[] = [`# ${p.title}`, ""];
  const stat = (rs: EvalRecord[], v: string, rule?: string) => {
    const cs = rs.filter((r) => r.variant === v && r.ok).flatMap((r) => r.checks.filter((c) => !rule || c.rule === rule));
    return { pass: cs.filter((c) => c.pass).length, total: cs.length };
  };
  const cell = (s: { pass: number; total: number }) => (s.total ? `${pct(s.pass, s.total)}（${s.pass}/${s.total}）` : "—");
  const delta = (a: { pass: number; total: number }, b: { pass: number; total: number }) => {
    if (!a.total || !b.total) return "";
    const d = Math.round((b.pass / b.total - a.pass / a.total) * 100);
    return d === 0 ? "＝" : d > 0 ? `▲${d}` : `▼${-d}`;
  };
  L.push("## 總覽", "", `| 模型組 | ${p.before.label} | ${p.after.label} | 變化 | 全部通過題數（前→後） |`, "|---|---|---|---|---|");
  for (const v of p.variants) {
    const a = stat(p.before.records, v);
    const b = stat(p.after.records, v);
    const allPass = (rs: EvalRecord[]) => rs.filter((r) => r.variant === v && r.ok && r.checks.every((c) => c.pass)).length;
    L.push(`| ${v} | ${cell(a)} | ${cell(b)} | ${delta(a, b)} | ${allPass(p.before.records)}→${allPass(p.after.records)} |`);
  }
  L.push("");
  const rules = [...new Set([...p.before.records, ...p.after.records].flatMap((r) => r.checks.map((c) => c.rule)))];
  L.push("## 各規則（只列前後有任何模型沒全過的規則）", "", `| 規則 | ${p.variants.map((v) => `${v} 前→後`).join(" | ")} |`, `|---|${p.variants.map(() => "---").join("|")}|`);
  for (const rule of rules) {
    const cells = p.variants.map((v) => ({ a: stat(p.before.records, v, rule), b: stat(p.after.records, v, rule) }));
    if (cells.every((c) => c.a.pass === c.a.total && c.b.pass === c.b.total)) continue;
    L.push(`| ${rule} | ${cells.map((c) => `${cell(c.a)}→${cell(c.b)} ${delta(c.a, c.b)}`).join(" | ")} |`);
  }
  L.push("");
  return L.join("\n");
}
