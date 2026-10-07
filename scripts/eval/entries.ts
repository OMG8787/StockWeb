/**
 * 四入口品質比較（2026-10-06 使用者：「目前建議與問答的關注分析還有直接提問來回答，哪個答案最準？」）：
 *   ① 今日建議卡（actionBrief.ts，名單與結論程式決定、AI 只寫理由與風險）
 *   ② 關注清單深度分析（ask.ts＋grounding/holdings.ts）
 *   ③ 個股頁「問AI關於」按鈕（ask.ts 帶 contextSymbol）
 *   ④ 直接提問（ask.ts）
 * 同一批股票、同一套逐檔規則（entryGraders.ts）＋NVIDIA 評審，每個入口一個平均分。
 *
 *   npx tsx scripts/eval/entries.ts --out 2026-10-06-entries-before
 *   npx tsx scripts/eval/entries.ts --stocks 6278:台表科,2330:台積電 --variants gemini --card none --out smoke
 *   npx tsx scripts/eval/entries.ts --regrade docs/eval/xxx.json     # 改了評分器後不用重打模型
 *
 * 一次只開一個程序（證交所對本機 IP 併發會封鎖）；題目間隔沿用 runtime.ts 的 CASE_GAP_MS。
 * ②③④ 的 Gemini 固定 gemini-flash-lite-latest（同正式站實際在用）；①今日建議卡兩種來源：
 *   --card prod＝讀正式站 /api/action-brief 現成文字；--card local＝本機 getActionBrief(true)（要 GEMINI_PREMIUM_LOCAL=true，用 1～2 次非 lite 額度）。
 */
import fs from "node:fs";
import path from "node:path";
import type { CheckResult, EvalCase } from "./types";
import { siteAuthHeaders } from "../siteAuth";
import { CASE_GAP_MS, arg, callVariant, captureCase, judge, log, postProcess, regenerateWith, sleep, type Captured } from "./runtime";
import { extractCardLine, extractStockSegment, gradeEntryStock, type EntryStock } from "./entryGraders";

const SITE = "https://stock-web-rho.vercel.app";
const DEFAULT_STOCKS = "6278:台表科,6285:啟碁,2313:華通,4720:德淵,2330:台積電";

export type EntryId = "card-prod" | "card-local" | "watchlist" | "button" | "direct";
export const ENTRY_LABEL: Record<EntryId, string> = {
  "card-prod": "①今日建議卡（正式站現成）",
  "card-local": "①今日建議卡（本機重生成）",
  watchlist: "②關注清單深度分析",
  button: "③個股頁問AI關於",
  direct: "④直接提問",
};

export interface EntryRecord {
  entry: EntryId;
  variant: string;
  model?: string;
  symbol: string;
  name: string;
  /** 該檔那一段（使用者實際看到的） */
  text: string;
  raw?: string;
  zhFixed: number;
  /** 整則回答長度（中文字，不含空白）——②是整份關注清單 */
  wholeChars: number;
  checks: CheckResult[];
  judge?: { score: number; reason: string; by?: string };
  postCheck?: { outcome: string; issues: string[] };
  /** ②關注清單：整則回答（重新分段／重新評分用） */
  finalWhole?: string;
}

interface Saved {
  startedAt: string;
  stocks: EntryStock[];
  groundings: Record<string, string>; // 個股參考資料（③的）：symbol → grounding
  watchGrounding?: string;
  records: EntryRecord[];
  failures: string[];
}

const plainLen = (t: string) => t.replace(/[*#\s]/g, "").length;

/**
 * 參考資料是否完整（2026-10-06 實測：上游短暫失敗時 loadStockRating 把缺資料的評等當正常結果快取 10 分鐘，
 * 台表科從建議買進變成「支持 1/5 先不要買」，這樣的回答比較沒有意義）。個股資料區塊缺日K歷史或三大法人＝不完整。
 */
export function groundingIncomplete(grounding: string): string | null {
  const blocks = grounding.split(/\n\n---\n\n/).filter((b) => b.includes("股票："));
  for (const b of blocks) {
    const name = b.match(/股票：([^（]+)（/)?.[1] ?? "?";
    if (b.includes("歷史走勢資料目前無法取得")) return `${name}缺日K歷史`;
    if (!b.includes("三大法人")) return `${name}缺三大法人`;
  }
  return null;
}

function parseStocks(s: string): EntryStock[] {
  return s.split(",").map((x) => {
    const [symbol, name] = x.split(":");
    return { symbol: symbol.trim(), name: (name ?? symbol).trim() };
  });
}

function mkCase(id: string, question: string, extra: Partial<EvalCase> = {}): EvalCase {
  return { id, title: id, question, checks: [], source: "四入口比較", tags: ["四入口"], ...extra };
}

async function main() {
  const regradePath = arg("regrade");
  if (regradePath) return regrade(regradePath);
  const cmpIdx = process.argv.indexOf("--compare");
  if (cmpIdx >= 0) return compare(process.argv[cmpIdx + 1], process.argv[cmpIdx + 2]);
  const stocks = parseStocks(arg("stocks") ?? DEFAULT_STOCKS);
  const variants = (arg("variants") ?? "gemini,nvidia").split(",");
  const cardMode = arg("card") ?? "prod"; // prod | local | both | none
  const judgeWith = arg("judge-with") ?? "nvidia";
  const withJudge = !process.argv.includes("--no-judge");
  const entriesToRun = (arg("entries") ?? "watchlist,button,direct").split(",");
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  const outBase = path.join("docs", "eval", arg("out") ?? `${date}-entries`);
  const saved: Saved = { startedAt: new Date().toISOString(), stocks, groundings: {}, records: [], failures: [] };
  const save = () => fs.writeFileSync(`${outBase}.json`, JSON.stringify(saved, null, 1));
  log(`四入口比較：${stocks.map((s) => `${s.name}(${s.symbol})`).join("、")}；模型 ${variants.join("／")}；入口 ${entriesToRun.join("、")}；今日建議卡 ${cardMode}`);

  // 先組③按鈕的個股資料：每檔的 grounding 是「該檔評等與資料」的比對基準（四入口用同一份）。
  // 之後每個入口各自 capture（②④也要各自的 grounding 才知道它們實際拿到什麼）。
  const runAnswer = async (entry: EntryId, c: EvalCase, targets: EntryStock[]) => {
    const cap = await captureCase(c);
    if ("error" in cap) {
      saved.failures.push(`${entry}/${c.id}：組參考資料失敗 ${cap.error}`);
      log(`  ✗ ${entry}/${c.id} 組參考資料失敗：${cap.error}`);
      return;
    }
    const incomplete = groundingIncomplete(cap.grounding);
    if (incomplete) {
      saved.failures.push(`${entry}/${c.id}：上游資料不完整（${incomplete}），結果作廢`);
      log(`  ✗ ${entry}/${c.id} 上游資料不完整（${incomplete}）——停止，請稍後重跑（評等會把缺資料的結果快取 10 分鐘）`);
      save();
      process.exit(2);
    }
    if (entry === "button") for (const t of targets) saved.groundings[t.symbol] = cap.grounding;
    if (entry === "watchlist") saved.watchGrounding = cap.grounding;
    const results = await Promise.all(
      variants.map(async (v) => {
        const r = await callVariant(v, cap as Captured);
        if ("error" in r) return { v, error: r.error };
        const pp = await postProcess(r.text, cap.grounding, (issues) => regenerateWith(v, cap as Captured, r.text, issues));
        return { v, raw: r.text, model: r.model, pp };
      })
    );
    for (const r of results) {
      if ("error" in r) {
        saved.failures.push(`${entry}/${c.id}/${r.v}：${r.error}`);
        log(`  ✗ ${entry}/${c.id}/${r.v}：${r.error}`);
        continue;
      }
      for (const t of targets) {
        const text = entry === "watchlist" ? extractStockSegment(r.pp.final, stocks, t.symbol) : r.pp.final;
        saved.records.push({
          entry,
          variant: r.v,
          model: r.model,
          symbol: t.symbol,
          name: t.name,
          text,
          raw: r.raw,
          zhFixed: r.pp.zhFixed,
          wholeChars: plainLen(r.pp.final),
          checks: [],
          ...(entry === "watchlist" ? { finalWhole: r.pp.final } : {}),
          ...(r.pp.outcome && r.pp.outcome !== "ok" ? { postCheck: { outcome: r.pp.outcome, issues: r.pp.issues ?? [] } } : {}),
        });
      }
    }
    log(`  ✓ ${entry}/${c.id}`);
    save();
    await sleep(CASE_GAP_MS);
  };

  if (entriesToRun.includes("button"))
    for (const s of stocks) await runAnswer("button", mkCase(`button-${s.symbol}`, `關於 ${s.name}（${s.symbol}），最近走勢如何？現在建議買還是不買？`, { contextSymbol: s.symbol }), [s]);
  if (entriesToRun.includes("direct"))
    for (const s of stocks) await runAnswer("direct", mkCase(`direct-${s.symbol}`, `${s.name}現在建議買還是不買？`), [s]);
  if (entriesToRun.includes("watchlist"))
    await runAnswer(
      "watchlist",
      mkCase("watchlist", "幫我分析一下我關注清單裡的每一檔股票", {
        holdings: stocks.map((s) => ({ symbol: s.symbol, market: "TW" as const, name: s.name })),
      }),
      stocks
    );
  // ②③④ 若沒跑③（沒有個股 grounding），用②或④的 grounding 補（評等行相同）。
  if (cardMode === "prod" || cardMode === "both") await collectCard("card-prod", saved, stocks);
  if (cardMode === "local" || cardMode === "both") await collectCard("card-local", saved, stocks);
  save();

  // 個股比對基準 grounding：優先③；沒有就用②的整份（評等行格式相同）。
  grade(saved);
  if (withJudge) await judgeAll(saved, judgeWith, save);
  save();
  fs.writeFileSync(`${outBase}.md`, renderEntriesReport(saved, outBase));
  log(`完成：${outBase}.md／.json`);
}

/** ① 今日建議卡：prod＝正式站現成；local＝本機 getActionBrief(true)（較強模型，需 GEMINI_PREMIUM_LOCAL=true）。 */
async function collectCard(entry: "card-prod" | "card-local", saved: Saved, stocks: EntryStock[]) {
  let text = "";
  let model = "";
  try {
    if (entry === "card-prod") {
      const res = await fetch(`${SITE}/api/action-brief`, { headers: siteAuthHeaders(), signal: AbortSignal.timeout(90_000) });
      const d = (await res.json()) as { actionBrief?: { text: string; model?: { name: string }; fellBackToLite?: boolean } };
      text = d.actionBrief?.text ?? "";
      model = `${d.actionBrief?.model?.name ?? "（程式版）"}${d.actionBrief?.fellBackToLite ? "（較強模型額度用完，退回 lite）" : ""}`;
    } else {
      // GEMINI_MODEL 會蓋掉分級選模型（gemini.ts），這一步要讓 premium 走非 lite。
      const saveModel = process.env.GEMINI_MODEL;
      delete process.env.GEMINI_MODEL;
      try {
        const { getActionBrief } = await import("@/lib/ai/actionBrief");
        const b = await getActionBrief(true);
        text = b.text;
        model = `${b.model?.name ?? "（程式版）"}${b.fellBackToLite ? "（退回 lite）" : ""}`;
      } finally {
        if (saveModel) process.env.GEMINI_MODEL = saveModel;
      }
    }
  } catch (err) {
    saved.failures.push(`${entry}：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let n = 0;
  for (const s of stocks) {
    const line = extractCardLine(text, s.symbol);
    if (!line) continue;
    n++;
    saved.records.push({ entry, variant: model, model, symbol: s.symbol, name: s.name, text: line, zhFixed: 0, wholeChars: plainLen(text), checks: [] });
  }
  log(`  ✓ ${entry}：${model}；名單內命中 ${n}/${stocks.length} 檔`);
}

function groundingFor(saved: Saved, symbol: string): string {
  return saved.groundings[symbol] ?? saved.watchGrounding ?? "";
}

function grade(saved: Saved) {
  for (const r of saved.records) {
    r.checks = r.text
      ? gradeEntryStock({
          stock: { symbol: r.symbol, name: r.name },
          text: r.text,
          raw: r.raw,
          zhFixedCount: r.zhFixed,
          grounding: groundingFor(saved, r.symbol),
          allowedSymbols: r.entry === "watchlist" ? saved.stocks.map((s) => s.symbol) : [r.symbol],
        })
      : [{ rule: "有該檔的回答", pass: false, detail: "回答裡找不到這一檔" }];
  }
}

/** 評審次數：NVIDIA 評審一次一個分數雜訊大（±0.5），預設每筆評 3 次取平均（reason 取第一次）。 */
const JUDGE_RUNS = Number(arg("judge-runs") ?? 3);

async function judgeAll(saved: Saved, judgeWith: string, save: () => void, force = false) {
  log(`LLM 評審中（每筆 ${JUDGE_RUNS} 次取平均）…`);
  for (const r of saved.records) {
    if (!r.text || (r.judge && !force)) continue;
    const q = r.entry === "button" ? `關於 ${r.name}（${r.symbol}），最近走勢如何？現在建議買還是不買？` : `${r.name}現在建議買還是不買？`;
    const scores: number[] = [];
    let reason = "";
    for (let i = 0; i < JUDGE_RUNS; i++) {
      const j = await judge(q, r.text, judgeWith).catch(() => undefined);
      if (j) {
        scores.push(j.score);
        if (!reason) reason = j.reason;
      }
      await sleep(3000);
    }
    if (scores.length) r.judge = { score: Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 100) / 100, reason, by: judgeWith };
    save();
  }
}

async function regrade(p: string) {
  const saved = JSON.parse(fs.readFileSync(p, "utf8")) as Saved;
  for (const r of saved.records) {
    if (r.entry === "watchlist" && r.finalWhole) {
      const text = extractStockSegment(r.finalWhole, saved.stocks, r.symbol);
      if (text !== r.text) {
        r.text = text;
        delete r.judge; // 文字變了，舊評審分數作廢
      }
    }
  }
  grade(saved);
  if (process.argv.includes("--rejudge")) await judgeAll(saved, arg("judge-with") ?? "nvidia", () => fs.writeFileSync(p, JSON.stringify(saved, null, 1)), process.argv.includes("--rejudge-all"));
  fs.writeFileSync(p, JSON.stringify(saved, null, 1));
  fs.writeFileSync(p.replace(/\.json$/, ".md"), renderEntriesReport(saved, p.replace(/\.json$/, "")));
  log(`重新評分完成：${p.replace(/\.json$/, ".md")}`);
}

/** 改前 vs 改後（只比兩邊都有的股票）：每個入口的規則通過率與評審平均、各規則通過率變化。 */
function compare(beforePath: string, afterPath: string) {
  const load = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as Saved;
  const before = load(beforePath);
  const after = load(afterPath);
  const common = new Set(before.records.map((r) => r.symbol).filter((s) => after.records.some((r) => r.symbol === s)));
  const key = (r: EntryRecord) => (r.entry.startsWith("card") ? ENTRY_LABEL[r.entry] : `${ENTRY_LABEL[r.entry]}｜${r.variant}`);
  const stat = (saved: Saved, k: string) => {
    const rs = saved.records.filter((r) => key(r) === k && common.has(r.symbol));
    const checks = rs.flatMap((r) => r.checks);
    const js = rs.map((r) => r.judge?.score).filter((x): x is number => typeof x === "number");
    return { n: rs.length, pass: checks.filter((c) => c.pass).length, total: checks.length, judge: js.length ? js.reduce((a, b) => a + b, 0) / js.length : NaN, chars: rs.length ? Math.round(rs.reduce((n, r) => n + plainLen(r.text), 0) / rs.length) : 0, rs };
  };
  const keys = [...new Set([...before.records, ...after.records].map(key))];
  const L: string[] = [`# 四入口改前 vs 改後：${path.basename(beforePath, ".json")} → ${path.basename(afterPath, ".json")}`, "", `- 只比兩邊都有的股票：${[...common].join("、")}；評審＝NVIDIA 每筆 3 次平均（只當參考）。`, ""];
  L.push("| 入口｜模型 | 檔數 | 規則通過率 改前→改後 | 評審平均 改前→改後 | 平均字數 改前→改後 |", "|---|---|---|---|---|");
  for (const k of keys) {
    const b = stat(before, k);
    const a = stat(after, k);
    if (!a.n && !b.n) continue;
    const pc = (x: { pass: number; total: number }) => (x.total ? `${Math.round((x.pass / x.total) * 100)}%` : "—");
    const jd = (x: { judge: number }) => (Number.isNaN(x.judge) ? "—" : x.judge.toFixed(2));
    L.push(`| ${k} | ${b.n}→${a.n} | ${pc(b)}→${pc(a)} | ${jd(b)}→${jd(a)} | ${b.chars}→${a.chars} |`);
  }
  L.push("", "## 各規則通過率變化（只列有差異的）", "", "| 入口｜模型 | 規則 | 改前 | 改後 |", "|---|---|---|---|");
  for (const k of keys) {
    const rules = [...new Set([...stat(before, k).rs, ...stat(after, k).rs].flatMap((r) => r.checks.map((c) => c.rule)))];
    for (const rule of rules) {
      const rate = (saved: Saved) => {
        const cs = stat(saved, k).rs.flatMap((r) => r.checks.filter((c) => c.rule === rule));
        return cs.length ? { t: `${Math.round((cs.filter((c) => c.pass).length / cs.length) * 100)}%`, v: cs.filter((c) => c.pass).length / cs.length } : { t: "—", v: NaN };
      };
      const b = rate(before);
      const a = rate(after);
      if (b.t !== a.t) L.push(`| ${k} | ${rule} | ${b.t} | ${a.t} |`);
    }
  }
  const out = path.join("docs", "eval", `${arg("out") ?? "entries-compare"}.md`);
  fs.writeFileSync(out, L.join("\n"));
  log(`比較表：${out}`);
}

// ---------------------------------------------------------------- 報告
const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a / b) * 100)}%`);

function groupKey(r: EntryRecord): string {
  return r.entry.startsWith("card") ? ENTRY_LABEL[r.entry] : `${ENTRY_LABEL[r.entry]}｜${r.variant}`;
}

export function renderEntriesReport(saved: Saved, outBase: string): string {
  const L: string[] = [];
  L.push(`# 四入口品質比較 ${path.basename(outBase)}`, "");
  L.push(`- 開始（UTC）：${saved.startedAt}；股票：${saved.stocks.map((s) => `${s.name}(${s.symbol})`).join("、")}`);
  L.push("- 規則＝entryGraders.ts 逐檔同一套（結論照抄評等、價位照抄、無內部標記／英文／簡體、不扯無關個股、把握程度照程式、融資融券訊號、做法／風險／數字）；評審＝NVIDIA 1～5 分（只當參考，同一個評審）。", "");
  const keys = [...new Set(saved.records.map(groupKey))];
  L.push("## 各入口分數", "", "| 入口｜模型 | 檔數 | 規則通過率 | 全部通過檔數 | 評審平均 | 平均字數（該檔） |", "|---|---|---|---|---|---|");
  for (const k of keys) {
    const rs = saved.records.filter((r) => groupKey(r) === k);
    const checks = rs.flatMap((r) => r.checks);
    const pass = checks.filter((c) => c.pass).length;
    const all = rs.filter((r) => r.checks.every((c) => c.pass)).length;
    const js = rs.map((r) => r.judge?.score).filter((x): x is number => typeof x === "number");
    const avgChars = Math.round(rs.reduce((n, r) => n + plainLen(r.text), 0) / Math.max(rs.length, 1));
    L.push(`| ${k} | ${rs.length} | ${pct(pass, checks.length)}（${pass}/${checks.length}） | ${all}/${rs.length} | ${js.length ? (js.reduce((a, b) => a + b, 0) / js.length).toFixed(2) : "—"} | ${avgChars} |`);
  }
  L.push("");
  const rules = [...new Set(saved.records.flatMap((r) => r.checks.map((c) => c.rule)))];
  L.push("## 各規則通過率（入口｜模型 × 規則）", "", `| 規則 | ${keys.join(" | ")} |`, `|---|${keys.map(() => "---").join("|")}|`);
  for (const rule of rules) {
    const cells = keys.map((k) => {
      const cs = saved.records.filter((r) => groupKey(r) === k).flatMap((r) => r.checks.filter((c) => c.rule === rule));
      return cs.length ? pct(cs.filter((c) => c.pass).length, cs.length) : "—";
    });
    L.push(`| ${rule} | ${cells.join(" | ")} |`);
  }
  L.push("", "## 失敗明細", "");
  for (const r of saved.records) {
    const bad = r.checks.filter((c) => !c.pass);
    if (bad.length === 0) continue;
    L.push(`- ${groupKey(r)}｜${r.name}(${r.symbol})：${bad.map((c) => `${c.rule}${c.detail ? `（${c.detail.replace(/\n/g, " ")}）` : ""}`).join("；")}`);
  }
  L.push("", "## 評審理由（每筆）", "");
  for (const r of saved.records) if (r.judge) L.push(`- ${groupKey(r)}｜${r.name}：${r.judge.score} 分——${r.judge.reason.replace(/\n/g, " ")}`);
  if (saved.failures.length) L.push("", "## 沒跑成的項目", "", ...saved.failures.map((f) => `- ${f}`));
  L.push("", "## 回答樣本（第一檔與最後一檔）", "");
  for (const sym of [saved.stocks[0]?.symbol, saved.stocks[saved.stocks.length - 1]?.symbol]) {
    if (!sym) continue;
    for (const r of saved.records.filter((x) => x.symbol === sym)) L.push(`### ${groupKey(r)}｜${r.name}`, "", r.text || "（無）", "");
  }
  return L.join("\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
